require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { createClient } = require('@supabase/supabase-js');
const { google } = require('googleapis');
const { Telegraf } = require('telegraf');
const ffmpeg = require('fluent-ffmpeg');

const app = express();
app.use(express.json());

const OUTPUT = path.join(__dirname, 'output');
if (!fs.existsSync(OUTPUT)) fs.mkdirSync(OUTPUT);

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

async function trendAgent() {
  const r = await axios.post('https://api.tavily.com/search', {
    api_key: process.env.TAVILY_API_KEY,
    query: 'Nifty50 stock market today India',
    search_depth: 'basic',
    max_results: 3
  });
  return r.data.results.map(x => x.title).join(', ');
}

async function scriptAgent(trends) {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: 'gemini-pro' });
  const prompt = `Write a short Hindi YouTube script about Nifty50 market today. Topics: ${trends}. Keep it under 150 words.`;
  const result = await model.generateContent(prompt);
  return result.response.text();
}

async function voiceAgent(script) {
  const r = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVENLABS_VOICE_ID}`,
    { text: script, model_id: 'eleven_multilingual_v2' },
    {
      headers: {
        'xi-api-key': process.env.ELEVENLABS_API_KEY,
        'Content-Type': 'application/json'
      },
      responseType: 'arraybuffer'
    }
  );
  const audioPath = path.join(OUTPUT, 'voice.mp3');
  fs.writeFileSync(audioPath, r.data);
  return audioPath;
}

async function imageAgent(trends) {
  const r = await axios.post(
    'https://api-inference.huggingface.co/models/stabilityai/stable-diffusion-2',
    { inputs: `Indian stock market Nifty50 ${trends}` },
    {
      headers: { Authorization: `Bearer ${process.env.HUGGINGFACE_API_KEY}` },
      responseType: 'arraybuffer'
    }
  );
  const imagePath = path.join(OUTPUT, 'thumbnail.png');
  fs.writeFileSync(imagePath, r.data);
  return imagePath;
}

async function videoAgent(trends) {
  const r = await axios.get(
    `https://api.pexels.com/videos/search?query=stock+market+india+${encodeURIComponent(trends)}&per_page=1`,
    { headers: { Authorization: process.env.PEXELS_API_KEY } }
  );
  const videoUrl = r.data.videos[0].video_files[0].link;
  const vr = await axios.get(videoUrl, { responseType: 'arraybuffer' });
  const videoPath = path.join(OUTPUT, 'bgvideo.mp4');
  fs.writeFileSync(videoPath, vr.data);
  return videoPath;
}

async function backupVideoAgent(trends) {
  const r = await axios.get(
    `https://pixabay.com/api/videos/?key=${process.env.PIXABAY_API_KEY}&q=stock+market+india+${encodeURIComponent(trends)}&per_page=1`
  );
  const videoUrl = r.data.hits[0].videos.medium.url;
  const vr = await axios.get(videoUrl, { responseType: 'arraybuffer' });
  const videoPath = path.join(OUTPUT, 'bgvideo_backup.mp4');
  fs.writeFileSync(videoPath, vr.data);
  return videoPath;
}

async function mergeAgent(videoPath, audioPath) {
  const out = path.join(OUTPUT, 'final_video.mp4');
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .input(audioPath)
      .outputOptions(['-shortest'])
      .save(out)
      .on('end', () => resolve(out))
      .on('error', reject);
  });
}

async function publishAgent(videoPath, title, description) {
  const oauth2Client = new google.auth.OAuth2(
    process.env.YOUTUBE_CLIENT_ID,
    process.env.YOUTUBE_CLIENT_SECRET,
    process.env.YOUTUBE_REDIRECT_URI
  );

  oauth2Client.setCredentials({ refresh_token: process.env.YOUTUBE_REFRESH_TOKEN });
  const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

  const res = await youtube.videos.insert({
    part: 'snippet,status',
    requestBody: {
      snippet: { title, description },
      status: { privacyStatus: 'public' }
    },
    media: {
      body: fs.createReadStream(videoPath)
    }
  });

  return res.data.id;
}

async function dbAgent(data) {
  await supabase.from('niftypulse_logs').insert([data]);
}

async function telegramAgent(message) {
  await bot.telegram.sendMessage(process.env.TELEGRAM_CHAT_ID, message);
}

async function cryptoAgent() {
  const r = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
    params: { ids: 'bitcoin,ethereum', vs_currencies: 'inr,usd' }
  });
  return r.data;
}

async function transcribeAgent(audioPath) {
  const file = fs.createReadStream(audioPath);
  const formData = new FormData();
  formData.append('file', file);
  formData.append('model', 'whisper-1');

  const r = await axios.post(
    'https://api.openai.com/v1/audio/transcriptions',
    formData,
    {
      headers: {
        Authorization: `Bearer ${process.env.WHISPER_API_KEY}`,
        ...formData.getHeaders()
      }
    }
  );

  return r.data.text;
}

async function runPipeline() {
  try {
    const trends = await trendAgent();
    const script = await scriptAgent(trends);
    const audioPath = await voiceAgent(script);
    await imageAgent(trends);
    let videoPath;
    try {
      videoPath = await videoAgent(trends);
    } catch {
      videoPath = await backupVideoAgent(trends);
    }

    const finalVideo = await mergeAgent(videoPath, audioPath);
    const transcript = await transcribeAgent(audioPath);
    const cryptoData = await cryptoAgent();

    const videoId = await publishAgent(
      finalVideo,
      `NiftyPulse Update - ${new Date().toDateString()}`,
      `${script}

Transcript: ${transcript}

Crypto: ${JSON.stringify(cryptoData)}`
    );

    await dbAgent({
      trends,
      script,
      transcript,
      cryptoData,
      videoId,
      createdAt: new Date().toISOString()
    });

    await telegramAgent(`✅ NiftyPulse video published: ${videoId}`);
    console.log('Pipeline done');
  } catch (err) {
    console.error(err);
    await telegramAgent(`❌ Pipeline failed: ${err.message}`);
  }
}

app.get('/', (req, res) => res.send('NiftyPulse is running'));
app.get('/api/healthz', (req, res) => res.json({ status: 'ok' }));
app.post('/api/run', async (req, res) => {
  res.json({ message: 'Pipeline started' });
  await runPipeline();
});

cron.schedule('30 13 * * *', runPipeline);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));
