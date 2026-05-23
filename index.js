import * as line from "@line/bot-sdk";
import express from "express";
import * as dotenv from "dotenv";
dotenv.config();
import { createClient } from '@supabase/supabase-js';
import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

// create LINE SDK config from env variables
const config = {
  //   channelSecret: "dac02cb36d732ee21fea69f1b98e326f",
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

// create LINE SDK client
const client = line.LineBotClient.fromChannelAccessToken({
  //   channelAccessToken: "XhwyGA9ERqNpbwTdVx67OBLFmLSJwt/AbEQQs28zMwdyl8ZiFFTMJ6xbLmnGjiqYJcwish9b+FuHmwoeVgebUAq4WB3WmjQsM/J0PfpXKyLv3orUfv0D9mW9lgmNXa086WQ/Go8VMJVpYnyJN3V19wdB04t89/1O/w1cDnyilFU="
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});

// create Supabase client
// Prefer a service role key for server-side inserts if provided.
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
const supabase = createClient(process.env.SUPABASE_URL, supabaseKey);

// Log whether Supabase env vars are present (don't print secrets)
console.log('Supabase configured:', {
  hasUrl: !!process.env.SUPABASE_URL,
  hasServiceRoleKey: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
  hasKey: !!process.env.SUPABASE_KEY,
});

// create Express app
// about Express itself: https://expressjs.com/
const app = express();

// test endpoint
app.get("/callback", (req, res) => {
  console.log("✅ GET /callback called");
  res.json({ status: "ok", message: "Webhook is working" });
});

// register a webhook handler with middleware
// about the middleware, please refer to doc
app.post("/callback", (req, res) => {
  console.log("📨 Request received at /callback");
  console.log("Headers:", req.headers);
  console.log("Body:", JSON.stringify(req.body, null, 2));

  line.middleware(config)(req, res, () => {
    console.log("✅ Middleware verified successfully");
    Promise.all(req.body.events.map(handleEvent))
      .then((result) => {
        console.log("✅ Reply sent:", result);
        res.json(result);
      })
      .catch((err) => {
        console.error("❌ Error:", err);
        res.status(500).end();
      });
  });
});

// (Removed duplicate simple handler) The async `handleEvent` below
// handles messages and logs them to Supabase.

// 4. ฟังก์ชันหลักในการจัดการ Event และบันทึกข้อมูล
async function handleEvent(event) {
  // รองรับเฉพาะ Event ประเภทข้อความ (Message Event) เท่านั้น
  if (event.type !== 'message') {
    return null;
  }

  const userId = event.source.userId || 'unknown';
  const replyToken = event.replyToken || '';
 
  // ดึงข้อมูลพื้นฐานจาก Message Object ของ LINE
  const messageId = event.message.id;
  const messageType = event.message.type; // text, image, sticker, video, etc.
 
  let content = null;
  let botReplyText = '';

  // ตรวจสอบเงื่อนไขตามประเภทข้อความ
  if (event.message.type === 'text') {
    content = event.message.text;
    const geminiResponse = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: content,
    });
    botReplyText = geminiResponse.text || 'ขออภัยครับ ระบบไม่สามารถสร้างคำตอบได้';
  } else if (event.message.type === 'image') {
    const messageId = event.message.id;
    content = `LINE image message id: ${messageId}`;

    try {
      const imageStream = await client.getMessageContent(messageId);
      const imageBuffer = await streamToBuffer(imageStream);
      const mimeType = imageStream.headers?.['content-type'] || 'image/jpeg';
      const base64Image = imageBuffer.toString('base64');

      const interaction = await ai.interactions.create({
        model: 'gemini-2.5-flash',
        input: [
          { type: 'text', text: 'Describe this image and tell me what it is.' },
          { type: 'image', data: base64Image, mime_type: mimeType },
        ],
      });

      const textOutputs = Array.isArray(interaction.outputs)
        ? interaction.outputs.map((output) => output.text).filter(Boolean)
        : [];
      botReplyText = textOutputs.join(' ') || 'ขออภัยครับ ระบบไม่สามารถบอกได้ว่าเป็นภาพอะไร';
    } catch (innerError) {
      console.error('Image analysis error:', innerError);
      botReplyText = 'ขออภัยครับ มีปัญหาในการวิเคราะห์รูปภาพของคุณ';
    }
  } else {
    // หากเป็นประเภทอื่น เช่น sticker, video
    content = `[Received ${messageType} message]`;
    botReplyText = `ได้รับข้อความประเภท ${messageType} แล้วครับ`;
  }

  try {
    // บันทึกข้อมูลลงตาราง messages ใน Supabase (บันทึกคู่ทั้งคำถามและคำตอบที่เตรียมไว้)
    const { data, error } = await supabase
      .from('messages')
      .insert([
        {
          user_id: userId,
          message_id: messageId,
          type: messageType,
          content: content,
          reply_token: replyToken,
          reply_content: botReplyText,
        },
      ])
      .select(); // return inserted rows for verification

    if (error) {
      console.error('Supabase Insert Error:', error);
    } else {
      console.log('Supabase Inserted:', Array.isArray(data) ? data.length : data);
      // optionally log inserted row id/key
      if (Array.isArray(data) && data[0]) console.log('Inserted row:', data[0]);
    }

    // ตอบกลับข้อความไปยังผู้ใช้ใน LINE
    return await client.replyMessage({
      replyToken: replyToken,
      messages: [
        {
          type: 'text',
          text: botReplyText,
        },
      ],
    });

  } catch (error) {
    console.error('เกิดข้อผิดพลาดในการประมวลผลระบบ:', error);
  }
}

// Simple test route to verify Gemini Flash 2.5 and Supabase inserts
app.get('/test-google-genai', async (req, res) => {
  const prompt = req.query.q || 'สวัสดี Gemini Flash 2.5';
  try {
    const geminiResponse = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
    });

    return res.json({
      ok: true,
      prompt,
      response: geminiResponse.text,
      fullResponse: geminiResponse,
    });
  } catch (err) {
    console.error('Gemini API error:', err);
    return res.status(500).json({ error: String(err) });
  }
});

// Simple test route to verify Supabase inserts without LINE middleware
app.get('/test-supabase', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('messages')
      .insert([
        {
          user_id: 'test_user',
          message_id: 'test-' + Date.now(),
          type: 'text',
          content: 'test message',
          reply_token: '',
          reply_content: 'test reply',
        },
      ])
      .select();

    if (error) {
      console.error('Test insert error:', error);
      return res.status(500).json({ error: error.message || error });
    }

    return res.json({ ok: true, inserted: data });
  } catch (err) {
    console.error('Test route error:', err);
    return res.status(500).json({ error: String(err) });
  }
});

app.get("/", (req, res) => {
  res.send("hello world, Sorawich Sudamart is here!");
});

// listen on port
const port = process.env.PORT || 3019;
app.listen(port, () => {
  console.log(`listening on ${port}`);
});
