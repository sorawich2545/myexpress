import * as line from '@line/bot-sdk'
import express from 'express'

// create LINE SDK config from env variables
const config = {
  channelSecret: "dac02cb36d732ee21fea69f1b98e326f",
};

// create LINE SDK client
const client = line.LineBotClient.fromChannelAccessToken({
  channelAccessToken: "XhwyGA9ERqNpbwTdVx67OBLFmLSJwt/AbEQQs28zMwdyl8ZiFFTMJ6xbLmnGjiqYJcwish9b+FuHmwoeVgebUAq4WB3WmjQsM/J0PfpXKyLv3orUfv0D9mW9lgmNXa086WQ/Go8VMJVpYnyJN3V19wdB04t89/1O/w1cDnyilFU="
});

// create Express app
// about Express itself: https://expressjs.com/
const app = express();

// test endpoint
app.get('/callback', (req, res) => {
  console.log('✅ GET /callback called');
  res.json({ status: 'ok', message: 'Webhook is working' });
});

// register a webhook handler with middleware
// about the middleware, please refer to doc
app.post('/callback', (req, res) => {
  console.log('📨 Request received at /callback');
  console.log('Headers:', req.headers);
  console.log('Body:', JSON.stringify(req.body, null, 2));
  
  line.middleware(config)(req, res, () => {
    console.log('✅ Middleware verified successfully');
    Promise
      .all(req.body.events.map(handleEvent))
      .then((result) => {
        console.log('✅ Reply sent:', result);
        res.json(result);
      })
      .catch((err) => {
        console.error('❌ Error:', err);
        res.status(500).end();
      });
  });
});

// event handler
function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    // ignore non-text-message event
    return Promise.resolve(null);
  }

  // create an echoing text message
  const echo = { type: 'text', text: event.message.text };

  // use reply API
  return client.replyMessage({
    replyToken: event.replyToken,
    messages: [echo],
  });
}

// listen on port
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`listening on ${port}`);
});