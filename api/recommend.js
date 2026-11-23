// api/recommend.js (초고속 응답 최적화 버전)
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

    const mealText = meals.length > 0
      ? meals.map((m) => m.name).join(', ')
      : '없음';

    // 응답 속도를 위해 프롬프트를 간결하게 압축
    const prompt = `여행지: ${location} / 키워드: ${keywords || '현지 맛집'} / 최소별점: ${minRating} / 영업중우선: ${openNow} / 최근식사(겹치지않게): ${mealText}.
실제 인기 식당 3곳과 근처 볼거리 2곳을 추천해줘. 좌표(x,y)는 2800x2800 지도 기준 중심(1400,1400) 반경 250~650px 내에 겹치지 않게 배치해.
반드시 아래 JSON 구조로만 짧고 간결하게 응답해:
{"cityMeta":{"centerName":"중심지","waterLabel":"강/바다","parkLabel":"공원","stations":["역1","역2","역3"]},"strategy":"추천전략 1줄","restaurants":[{"id":"r1","name":"한글명","localName":"원문명","category":"카테고리","signatureMenu":"대표메뉴","rating":4.2,"reviews":500,"walkTime":"도보 5분","price":"가격대","hours":"영업시간","tip":"짧은 팁","isOpen":true,"x":1220,"y":1310}],"attractions":[{"id":"a1","name":"한글명","localName":"원문명","category":"카테고리","walkTime":"도보 6분","hours":"영업시간","tip":"짧은 팁","x":1580,"y":1250}]}`;

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${apiKey}`;

    const callGemini = async (useFastThinking) => {
      const generationConfig = {
        responseMimeType: 'application/json',
        temperature: 0.7,
        maxOutputTokens: 1500,
      };
      if (useFastThinking) {
        generationConfig.thinkingConfig = { thinkingBudget: 0 };
      }

      return fetch(geminiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig,
        }),
      });
    };

    // 1차: 추론 끄고 초고속 호출 (미지원 시 자동으로 일반 호출 폴백)
    let response = await callGemini(true);
    if (response.status === 400) {
      response = await callGemini(false);
    }

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      return res.status(502).json({ error: `Gemini 오류: ${errData.error?.message || response.status}` });
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      return res.status(502).json({ error: 'AI 응답이 비어 있습니다.' });
    }

    return res.status(200).json(JSON.parse(text));
  } catch (err) {
    return res.status(500).json({ error: `서버 오류: ${err.message}` });
  }
};
