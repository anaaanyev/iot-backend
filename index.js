import express from 'express';
import mqtt from 'mqtt';
import cors from 'cors';
import fs from 'fs';

const app = express();
const PORT = process.env.PORT || 3000;

const USERS_FILE = './users.json';

// Функции чтения и записи
function loadUsers() {
    if (!fs.existsSync(USERS_FILE)) return {};
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'));
}

function saveUsers(data) {
    fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2));
}


function getDeviceIdFromInit(initData) {
    const userData = new URLSearchParams(initData);
    const user_id = userData.get("user").match(/"id":(\d+)/)[1];

    const users = loadUsers();
    return users[user_id];
}


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
let latestDataByDevice = {}; // device_id → данные

client.on('connect', () => {
    console.log('🔌 MQTT connected');
    client.subscribe('devices/climate01/data');
});

client.on('message', (topic, message) => {
    if (topic.startsWith('devices/') && topic.endsWith('/data')) {
        const device_id = topic.split('/')[1];
        try {
            const payload = JSON.parse(message.toString());
            latestDataByDevice[device_id] = { ...payload, timestamp: new Date() };
        } catch (e) {
            console.error('Ошибка парсинга MQTT:', e);
        }
    }
});

app.use(cors());
app.use(express.json());

// Получить последние данные
app.get('/get-latest', (req, res) => {
    const initData = req.query.initData;
    const device_id = getDeviceIdFromInit(initData);
    res.json(latestDataByDevice[device_id] || {});
});

// Установить порог температуры
app.post('/set-threshold', (req, res) => {
    const { threshold, initData } = req.body;
    const device_id = getDeviceIdFromInit(initData);

    const topic = `devices/${device_id}/threshold`;
    client.publish(topic, String(threshold));
    res.json({ ok: true });
});

// Маршрут регистрации
app.post('/register', (req, res) => {
    const { initData, device_id } = req.body;

    try {
        const userData = new URLSearchParams(initData);
        const user_id = userData.get("user").match(/"id":(\d+)/)[1];

        const users = loadUsers();
        users[user_id] = device_id;
        saveUsers(users);

        res.json({ ok: true });
    } catch (err) {
        res.status(400).json({ error: "Invalid initData" });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
