const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const app = express();
app.use(express.json());

const CLIENT_ID = process.env.NAVER_CLIENT_ID;
const CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("❌ NAVER_CLIENT_ID 또는 NAVER_CLIENT_SECRET가 .env에서 로드되지 않았습니다.");
  process.exit(1);
} else {
  console.log("✅ 네이버 API 키 로드 성공");
}

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir);
  console.log(`✅ 'data' 폴더가 생성되었습니다: ${dataDir}`);
}

class Topic {
  constructor(koreanName, englishName) {
    this.koreanName = koreanName;
    this.englishName = englishName;
    this.dailyNewsCount = 0;
    this.lastSentDate = null;
  }
}

const topicFilePath = path.join(dataDir, 'topics.json');
const watchlist = [];
if (fs.existsSync(topicFilePath)) {
  const raw = fs.readFileSync(topicFilePath, 'utf-8');
  JSON.parse(raw).forEach(t => watchlist.push(new Topic(t.korean, t.english)));
}


async function sendTelegramMessage(item, topic) {
  if (!item || !topic) return;

  const chatIds = process.env.TELEGRAM_CHAT_IDS
    ? process.env.TELEGRAM_CHAT_IDS.split(',').map(id => id.trim())
    : [];

  if (!TELEGRAM_BOT_TOKEN || chatIds.length === 0) return;

  const title = item.title ? item.title.replace(/<[^>]+>/g, '') : "제목 없음";
  const link = item.link || "";
  const topicName = topic.koreanName || "주제";
  const text = `[${topicName}][총 ${topic.dailyNewsCount}개의 뉴스] ${title}\n${link}`;
  const telegramURL = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

  for (const chatId of chatIds) {
    try {
      await axios.post(telegramURL, {
        chat_id: chatId,
        text: text,
        parse_mode: 'HTML'
      });
    } catch (err) {
      console.error(`⚠️ 텔레그램 전송 실패 (chat_id: ${chatId}):`, err.response?.data || err.message);
    }
  }
}

async function fetchAndSaveNewsByDate(topic, dateString) {
  const query = topic.koreanName;
  const targetDate = new Date(dateString);
  const maxResults = 1000;
  const displayCount = 100;
  let start = 1;

  let allFilteredItems = [];

  try {
    while (start <= maxResults) {
      const response = await axios.get('https://openapi.naver.com/v1/search/news.json', {
        params: {
          query: query,
          display: displayCount,
          start: start,
          sort: 'date',
        },
        headers: {
          'X-Naver-Client-Id': CLIENT_ID,
          'X-Naver-Client-Secret': CLIENT_SECRET,
        },
      });

      const items = response.data.items;
      if (!items || items.length === 0) break;

      const KSTOffset = 9 * 60 * 60 * 1000;
      const startOfDayKST = new Date(targetDate);
      startOfDayKST.setHours(0, 0, 0, 0);

      const startOfDayUTC = new Date(startOfDayKST.getTime() - KSTOffset);

      const filtered = items.filter(item => {
        const pubDate = new Date(item.pubDate);
        return pubDate >= startOfDayUTC;
      });

      allFilteredItems = allFilteredItems.concat(filtered);

      if (items.length < displayCount) break;
      start += displayCount;
    }

    const fileName = `${dateString.replace(/-/g, '_')}_${topic.englishName}_news.json`;
    const filePath = path.join(dataDir, fileName);

    let existingItems = [];
    if (fs.existsSync(filePath)) {
      try {
        const rawData = fs.readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(rawData);
        existingItems = parsed.items || [];
      } catch {
        existingItems = [];
      }
    }

    const existingLinks = new Set(existingItems.map(item => item.originallink));
    const uniqueNewItems = allFilteredItems.filter(item => !existingLinks.has(item.originallink));

    if (uniqueNewItems.length === 0) {
      console.log(`[${dateString}] 새로운 뉴스 없음`);
      return;
    }

    const combinedItems = [...uniqueNewItems, ...existingItems];
    combinedItems.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

    const dataToSave = {
      lastBuildDate: new Date().toUTCString(),
      total: combinedItems.length,
      start: 1,
      display: combinedItems.length,
      items: combinedItems,
    };

    fs.writeFileSync(filePath, JSON.stringify(dataToSave, null, 2), 'utf-8');
    console.log(`✅ [${dateString}] 뉴스 ${uniqueNewItems.length}개 추가 저장, 총 ${combinedItems.length}개 뉴스`);
    topic.dailyNewsCount = combinedItems.length;
    for (let i = 0; i < uniqueNewItems.length; i++) {
      await sendTelegramMessage(uniqueNewItems[i], topic);
    }

  } catch (error) {
    console.error(`[${dateString}] 뉴스 저장 실패:`, error.response?.data || error.message);
  }
}

cron.schedule('*/20 * * * * *', () => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const formattedDate = `${year}-${month}-${day}`;

  //topic별로 보내기
  (async () => {
    for (let i = 0; i < watchlist.length; i++) {
      if (formattedDate !== watchlist[i].lastSentDate) {
        watchlist[i].lastSentDate = formattedDate;
        watchlist[i].dailyNewsCount = 0;
      }
      console.log(`⏰ [${watchlist[i].koreanName}] ${formattedDate} 뉴스 자동 저장 실행 중...`);
      await fetchAndSaveNewsByDate(watchlist[i], formattedDate);
    }
  })();
});

app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/market-news', (req, res) => {
  const dateParam = req.query.date;
  if (!dateParam) return res.status(400).json({ error: 'date 파라미터가 필요합니다.' });

  const fileName = `${dateParam.replace(/-/g, '_')}_${samsung.englishName}_news.json`;
  const filePath = path.join(dataDir, fileName);

  if (!fs.existsSync(filePath)) {
    return res.json({ items: [] });
  }

  try {
    const rawData = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(rawData);
    res.json(parsed);
  } catch (error) {
    console.error(`[${dateParam}] 뉴스 파일 읽기 실패:`, error.message);
    res.status(500).json({ error: '뉴스 파일 읽기 실패' });
  }
});


app.post('/api/save-topic', (req, res) => {
  const { korean, english } = req.body;

  if (!korean || !english) {
    return res.status(400).json({ message: 'korean과 english를 모두 입력하세요.' });
  }

  const newTopic = { korean, english };

  let existingTopics = [];
  if (fs.existsSync(topicFilePath)) {
    try {
      const raw = fs.readFileSync(topicFilePath, 'utf-8');
      existingTopics = JSON.parse(raw);
    } catch (e) {
      console.error('topics.json 파싱 오류:', e);
    }
  }

  const isDuplicate = existingTopics.some(
    t => t.korean === korean && t.english === english
  );
  if (isDuplicate) {
    return res.status(200).json({ message: '이미 존재하는 토픽입니다.' });
  }

  existingTopics.push(newTopic);
  fs.writeFileSync(topicFilePath, JSON.stringify(existingTopics, null, 2), 'utf-8');
  res.status(200).json({ message: '토픽이 성공적으로 저장되었습니다.' });
  watchlist.push(new Topic(korean, english));
});

// 🔍 저장된 토픽 목록 조회
app.get('/api/topics', (req, res) => {
  if (!fs.existsSync(topicFilePath)) {
    return res.json([]);
  }

  try {
    const raw = fs.readFileSync(topicFilePath, 'utf-8');
    const topics = JSON.parse(raw);
    res.json(topics);
  } catch (error) {
    console.error('topics.json 읽기 실패:', error.message);
    res.status(500).json({ error: '토픽 파일 읽기 실패' });
  }
});

// ❌ 토픽 삭제
app.delete('/api/delete-topic', (req, res) => {
  const { korean, english } = req.body;

  if (!korean || !english) {
    return res.status(400).json({ message: 'korean과 english를 모두 입력하세요.' });
  }

  if (!fs.existsSync(topicFilePath)) {
    return res.status(404).json({ message: '토픽 데이터가 존재하지 않습니다.' });
  }

  try {
    const raw = fs.readFileSync(topicFilePath, 'utf-8');
    let topics = JSON.parse(raw);

    const updatedTopics = topics.filter(
      t => !(t.korean === korean && t.english === english)
    );

    fs.writeFileSync(topicFilePath, JSON.stringify(updatedTopics, null, 2), 'utf-8');
    res.status(200).json({ message: '토픽이 삭제되었습니다.' });
    const index = watchlist.findIndex(t => t.englishName === english);
    if (index !== -1) watchlist.splice(index, 1);
  } catch (error) {
    console.error('토픽 삭제 중 오류:', error.message);
    res.status(500).json({ message: '토픽 삭제 중 오류' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 서버 실행 중: http://localhost:${PORT}`);
  console.log("자동 뉴스 저장이 활성화되었습니다.");
});