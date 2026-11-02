import express from 'express';
import { AccessToken } from 'livekit-server-sdk';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const LIVEKIT_URL = process.env.LIVEKIT_URL;
const API_KEY = process.env.LIVEKIT_API_KEY;
const API_SECRET = process.env.LIVEKIT_API_SECRET;

app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

app.get('/token', async (req, res) => {
    const { room = 'test', identity = 'user' } = req.query;
    try {
        const at = new AccessToken(API_KEY, API_SECRET, { identity, ttl: '1h' });
        at.addGrant({ roomJoin: true, room });
        const token = await at.toJwt();
        res.json({ url: LIVEKIT_URL, token, room, identity });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});
