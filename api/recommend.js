// api/recommend.js (Vercel Node.js Serverless Function)
const rateLimitMap = new Map();

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // 1. IP 기반 호출 제한 (1분당 최대 10회)
  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  const now = Date.now();
  const userLogs = (rateLimitMap.get(ip) || []).filter((t) => now - t < 60 * 1000);
  if (userLogs.length >= 10) {
    return res.status(429).json({ error: '요청이 너무 많습니다. 1분 뒤에 다시 시도해 주세요.' });
  }
  userLogs.push(now);
  rateLimitMap.set(ip, userLogs);

  // 2. 환경변수 확인 (공백 자동 제거)
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) {
    return res.status(500).json({ error: 'Vercel 환경변수(GEMINI_API_KEY)가 비어 있습니다. 등록 후 Redeploy 해주세요.' });
  }

  try {
    const { location, keywords, minRating = 3.5, openNow = true, meals = [] } = req.body || {};
    if (!location) {
      return res.status(400).json({ error: '여행 국가/도시를 입력해 주세요.' });
    }

    const mealText = meals.length > 0
      ? meals.map((m) => `- ${m.name} (${m.tags || ''})`).join('\n')
      : '아직 식사 기록 없음';

    const prompt = `
너는 글로벌 현지 여행 미식 & 동선 가이드 AI야.
아래 조건에 맞춰 실제 존재하는 인기 식당 4곳과 식후 도보 10분 이내 볼거리 2곳을 추천해 줘.

[사용자 조건]
- 여행지(국가/도시): ${location}
- 원하는 키워드: ${keywords || '현지인 인기 맛집, 대표 메뉴'}
- 최소 구글 평점 기준: ${minRating} 이상
- 현재 영업 중 우선: ${openNow ? '예' : '상관없음'}
- 최근 먹은 음식 기록 (이 음식들과 맛·재료·조리법이 최대한 겹치지 않게 추천):
${mealText}

[필수 규칙]
1. 모든 좌표(x, y)는 2800x2800 가상 지도 기준이며, 중심(1400, 1400) 반경 250~700px 안에 서로 겹치지 않게 배치해 줘.
2. 반드시 아래 JSON 형식으로만 응답해 줘.

{
  "cityMeta": {
    "centerName": "기준 랜드마크 또는 중심 구역명",
    "waterLabel": "강/바다/운하 이름 (없으면 인근 수변)",
    "parkLabel": "대표 공원/광장 이름",
    "stations": ["대표역1", "대표역2", "대표역3"]
  },
  "strategy": "최근 식단과 키워드를 반영한 메뉴 추천 전략 한 줄 요약",
  "restaurants": [
    {
      "id": "r1",
      "name": "식당명 (한국어)",
      "localName": "현지어 원문 식당명",
      "category": "카테고리",
      "signatureMenu": "대표 추천 메뉴 1~2개",
      "rating": 4.2,
      "reviews": 850,
      "walkTime": "도보 5분",
      "price": "1인 약 1,500엔 / 15유로 등",
      "hours": "11:00~22:00 (브레이크타임/휴무 주의사항)",
      "tip": "추천 이유 및 웨이팅·혼밥 팁 (1~2줄)",
      "isOpen": true,
      "x": 1220,
      "y": 1310
    }
  ],
  "attractions": [
    {
      "id": "a1",
      "name": "볼거리 이름 (한국어)",
      "localName": "현지어 원문명",
      "category": "쇼핑/야경/산책 등",
      "walkTime": "도보 6분",
      "hours": "10:00~23:00",
      "tip": "식후 소화 겸 들르기 좋은 포인트 1줄",
      "x": 1580,
      "y": 1250
    }
  ]
}
`;

    // 3. Gemini 모델 순차 시도 (404 발생 시 자동 폴백)
    const models = ['gemini-3.8-flash', 'gemini-3.0-flash', 'gemini-2.5-flash'];
    let lastErrorMsg = '';

    for (const model of models) {
      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const response = await fetch(geminiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.7,
          },
        }),
      });

      if (response.ok) {
        const data = await response.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) {
          return res.status(502).json({ error: 'AI 응답이 비어 있습니다.' });
        }
        return res.status(200).json(JSON.parse(text));
      }

      const errData = await response.json().catch(() => ({}));
      lastErrorMsg = errData.error?.message || `HTTP ${response.status}`;

      // 404(모델 없음)가 아니면 바로 에러 반환 (키 오류, 한도 초과 등)
      if (response.status !== 404) {
        return res.status(502).json({ error: `Gemini API 오류: ${lastErrorMsg}` });
      }
    }

    return res.status(502).json({ error: `Gemini 모델 호출 실패: ${lastErrorMsg}` });
  } catch (err) {
    return res.status(500).json({ error: `서버 처리 오류: ${err.message}` });
  }
};
