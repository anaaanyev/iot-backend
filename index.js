import express from 'express';
import mqtt from 'mqtt';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3000;

// MQTT настройки
const mqttOptions = {
    host: process.env.MQTT_SERVER,
    port: Number(process.env.MQTT_PORT),
    username: process.env.MQTT_USER,
    password: process.env.MQTT_PASSWORD,
    protocol: 'mqtt'
};

const client = mqtt.connect(mqttOptions);

// Последние данные от устройства
let latestData = {
    temperature: null,
    humidity: null,
    threshold: null,
    timestamp: null
};

client.on('connect', () => {
    console.log('🔌 MQTT connected');
    client.subscribe('devices/climate01/data');
});

client.on('message', (topic, message) => {
    if (topic === 'devices/climate01/data') {
        try {
            const payload = JSON.parse(message.toString());
            latestData = { ...payload, timestamp: new Date() };
        } catch (e) {
            console.error('Ошибка парсинга MQTT:', e);
        }
    }
});

app.use(cors());
app.use(express.json());

// Получить последние данные
app.get('/get-latest', (req, res) => {
    res.json(latestData);
});

// Установить порог температуры
app.post('/set-threshold', (req, res) => {
    const { threshold } = req.body;
    if (typeof threshold === 'number') {
        const topic = 'devices/climate01/threshold';
        client.publish(topic, String(threshold));
        res.json({ ok: true });
    } else {
        res.status(400).json({ error: 'Invalid threshold' });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
