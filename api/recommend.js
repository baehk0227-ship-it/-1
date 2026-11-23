// api/recommend.js (504 타임아웃 방지 초고속 버전)
const rateLimitMap = new Map();

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  const now = Date.now();
  const userLogs = (rateLimitMap.get(ip) || []).filter((t) => now - t < 60 * 1000);
  if (userLogs.length >= 10) {
    return res.status(429).json({ error: '요청이 너무 많습니다. 1분 뒤에 다시 시도해 주세요.' });
  }
  userLogs.push(now);
  rateLimitMap.set(ip, userLogs);

  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY 환경변수가 없습니다.' });
  }

  try {
    const { location, keywords, minRating = 3.5, openNow = true, meals = [] } = req.body || {};
    if (!location) {
      return res.status(400).json({ error: '여행 국가/도시를 입력해 주세요.' });
    }

    const mealText = meals.length > 0 ? meals.map((m) => m.name).join(', ') : '없음';
    const prompt = `여행지:${location}, 키워드:${keywords || '현지 맛집'}, 최소별점:${minRating}, 영업중:${openNow}, 최근식사:${mealText}.
실제 인기 식당 3곳과 근처 볼거리 2곳 추천. 좌표(x,y)는 2800x2800 기준 (1400,1400) 반경 250~650px 내 배치.
반드시 아래 JSON만 짧게 출력:
{"cityMeta":{"centerName":"중심지","waterLabel":"강/바다","parkLabel":"공원","stations":["역1","역2","역3"]},"strategy":"추천전략 1줄","restaurants":[{"id":"r1","name":"한글명","localName":"원문명","category":"카테고리","signatureMenu":"대표메뉴","rating":4.2,"reviews":500,"walkTime":"도보 5분","price":"가격대","hours":"영업시간","tip":"짧은 팁","isOpen":true,"x":1220,"y":1310}],"attractions":[{"id":"a1","name":"한글명","localName":"원문명","category":"카테고리","walkTime":"도보 6분","hours":"영업시간","tip":"짧은 팁","x":1580,"y":1250}]}`;

    // 가볍고 빠른 모델부터 시도 (각 모델당 최대 8초만 대기)
    const models = ['gemini-3.8-flash-lite', 'gemini-3.8-flash'];
    let lastError = '응답 시간 초과';

    for (const model of models) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      try {
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        const response = await fetch(geminiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              responseMimeType: 'application/json',
              temperature: 0.7,
              maxOutputTokens: 1200,
              thinkingConfig: { thinkingBudget: 0 },
            },
          }),
        });
        clearTimeout(timeoutId);

        if (response.ok) {
          const data = await response.json();
          const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) return res.status(200).json(JSON.parse(text));
        } else {
          const errData = await response.json().catch(() => ({}));
          lastError = errData.error?.message || `HTTP ${response.status}`;
        }
      } catch (e) {
        clearTimeout(timeoutId);
        lastError = e.name === 'AbortError' ? `${model} 응답 지연(8초 초과)` : e.message;
      }
    }

    return res.status(502).json({ error: `AI 응답 지연/오류: ${lastError}` });
  } catch (err) {
    return res.status(500).json({ error: `서버 오류: ${err.message}` });
  }
};
