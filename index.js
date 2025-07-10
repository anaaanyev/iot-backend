import express from 'express';
import mqtt from 'mqtt';
import cors from 'cors';
import fs from 'fs';

const app = express();
const PORT = process.env.PORT || 3000;

const USERS_FILE = './users.json';

// Список валидных устройств
const VALID_DEVICES = ['climate01', 'climate02', 'climate03'];

// Функции чтения и записи
function loadUsers() {
    if (!fs.existsSync(USERS_FILE)) return {};
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'));
}

function saveUsers(data) {
    fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2));
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
    // Подписываемся на все устройства
    VALID_DEVICES.forEach(device => {
        client.subscribe(`devices/${device}/data`);
    });
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

// Маршрут регистрации
app.post('/register', (req, res) => {
    const { device_id, telegram_id, username, first_name, last_name } = req.body;

    try {
        // Проверка валидности устройства
        if (!VALID_DEVICES.includes(device_id)) {
            return res.status(400).json({ error: 'Неверный ID устройства' });
        }

        const users = loadUsers();

        // Проверка - не занято ли уже это устройство
        const existingUser = Object.keys(users).find(userId => users[userId].device_id === device_id);
        if (existingUser && existingUser !== String(telegram_id)) {
            return res.status(400).json({ error: 'Устройство уже привязано к другому пользователю' });
        }

        // Сохраняем данные пользователя
        users[telegram_id] = {
            device_id,
            username,
            first_name,
            last_name,
            registered_at: new Date().toISOString()
        };

        saveUsers(users);

        console.log(`✅ Пользователь ${telegram_id} зарегистрирован для устройства ${device_id}`);
        res.json({ ok: true, message: 'Регистрация успешна' });

    } catch (err) {
        console.error('Ошибка регистрации:', err);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Проверка авторизации пользователя
app.get('/check-auth', (req, res) => {
    const { telegram_id } = req.query;

    if (!telegram_id) {
        return res.status(400).json({ error: 'Не указан telegram_id' });
    }

    const users = loadUsers();
    const user = users[telegram_id];

    if (user) {
        res.json({ authorized: true, device_id: user.device_id });
    } else {
        res.json({ authorized: false });
    }
});

// Получить последние данные
app.get('/get-latest', (req, res) => {
    const { device_id } = req.query;

    if (!device_id) {
        return res.status(400).json({ error: 'Не указан device_id' });
    }

    const data = latestDataByDevice[device_id] || {};
    res.json(data);
});

// Установить порог температуры
app.post('/set-threshold', (req, res) => {
    const { threshold, device_id } = req.body;

    if (!device_id) {
        return res.status(400).json({ error: 'Не указан device_id' });
    }

    if (!VALID_DEVICES.includes(device_id)) {
        return res.status(400).json({ error: 'Неверный device_id' });
    }

    const topic = `devices/${device_id}/threshold`;
    client.publish(topic, String(threshold));

    console.log(`🌡️ Установлен порог ${threshold}°C для устройства ${device_id}`);
    res.json({ ok: true });
});

// Отвязать устройство от пользователя
app.post('/unregister', (req, res) => {
    const { telegram_id } = req.body;

    if (!telegram_id) {
        return res.status(400).json({ error: 'Не указан telegram_id' });
    }

    const users = loadUsers();

    if (users[telegram_id]) {
        const device_id = users[telegram_id].device_id;
        delete users[telegram_id];
        saveUsers(users);

        console.log(`🔓 Пользователь ${telegram_id} отвязан от устройства ${device_id}`);
        res.json({ ok: true, message: 'Устройство отвязано' });
    } else {
        res.status(404).json({ error: 'Пользователь не найден' });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});