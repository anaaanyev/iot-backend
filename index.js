import express from 'express';
import mqtt from 'mqtt';
import cors from 'cors';
import { MongoClient } from 'mongodb';

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================================
// ФАЗА 1: БАЗОВАЯ СТРУКТУРА И КОНФИГУРАЦИЯ
// ============================================================================

// 1.1 Подключение к MongoDB
const client = new MongoClient(process.env.MONGODB_URI);
const dbName = 'iotHubDB';

async function connectToMongoDB() {
    try {
        await client.connect();
        console.log('🗄️ MongoDB подключена');
    } catch (err) {
        console.error('Ошибка подключения к MongoDB:', err);
        // Повторная попытка через 5 секунд
        setTimeout(connectToMongoDB, 5000);
    }
}

// Инициализировать подключение при запуске
connectToMongoDB();

// 1.2 Конфигурация типов устройств
const DEVICE_TYPES = {
    climate: {
        name: "Климат-контроль",
        icon: "🌡️",
        mqttTopics: {
            data: "devices/{device_id}/data",
            threshold: "devices/{device_id}/threshold"
        },
        defaultSettings: { threshold: 25 },
        validation: {
            threshold: { min: 0, max: 40, type: "number" }
        },
        uiPath: "/devices/climate/"
    },
    smartdim: {
        name: "Управление освещением",
        icon: "💡",
        mqttTopics: {
            data: "devices/{device_id}/data",
            brightness: "devices/{device_id}/brightness",
            schedule: "devices/{device_id}/schedule"
        },
        defaultSettings: { brightness: 50, schedule: null },
        validation: {
            brightness: { min: 0, max: 100, type: "number" }
        },
        uiPath: "/devices/smartdim/"
    }
    // НОВЫЕ ТИПЫ УСТРОЙСТВ ДОБАВЛЯЮТСЯ ЗДЕСЬ
};

// 1.3 Конфигурация валидных устройств
const VALID_DEVICES = {
    // Климат-контроль
    climate01: { type: 'climate', defaultName: 'Climate Sensor #1' },
    climate02: { type: 'climate', defaultName: 'Climate Sensor #2' },
    climate03: { type: 'climate', defaultName: 'Climate Sensor #3' },

    // Диммеры (пример для будущего расширения)
    smartdim01: { type: 'smartdim', defaultName: 'Smart Dimmer #1' },
    smartdim02: { type: 'smartdim', defaultName: 'Smart Dimmer #2' },

    // НОВЫЕ УСТРОЙСТВА ДОБАВЛЯЮТСЯ ЗДЕСЬ
};

// ============================================================================
// ФАЗА 2: СЕРВИСЫ И РАБОТА С ДАННЫМИ
// ============================================================================

// 2.1 Сервис для работы с пользователями
class UserService {
    static async getUser(telegramId) {
        try {
            await client.connect();
            const db = client.db(dbName);
            const numericId = typeof telegramId === 'string' ? parseInt(telegramId, 10) : telegramId;
            const user = await db.collection('users').findOne({ _id: numericId });
            return user;
        } catch (err) {
            console.error('Ошибка получения пользователя:', err);
            return null;
        }
    }

    static async addDevice(telegramId, deviceId, userInfo) {
        try {
            await client.connect();
            const db = client.db(dbName);

            const deviceConfig = VALID_DEVICES[deviceId];
            const deviceType = DEVICE_TYPES[deviceConfig.type];

            const newDevice = {
                device_id: deviceId,
                device_type: deviceConfig.type,
                custom_name: deviceConfig.defaultName,
                settings: deviceType.defaultSettings,
                registered_at: new Date().toISOString()
            };

            await db.collection('users').updateOne(
                { _id: telegramId },
                {
                    $set: {
                        username: userInfo.username,
                        first_name: userInfo.first_name,
                        last_name: userInfo.last_name,
                        updated_at: new Date().toISOString()
                    },
                    $push: { devices: newDevice }
                },
                { upsert: true }
            );

            return { success: true, device: newDevice };
        } catch (err) {
            console.error('Ошибка добавления устройства:', err);
            return { success: false, error: err.message };
        }
    }

    static async removeDevice(telegramId, deviceId) {
        try {
            await client.connect();
            const db = client.db(dbName);

            await db.collection('users').updateOne(
                { _id: telegramId },
                { $pull: { devices: { device_id: deviceId } } }
            );

            return { success: true };
        } catch (err) {
            console.error('Ошибка удаления устройства:', err);
            return { success: false, error: err.message };
        }
    }

    static async updateDeviceName(telegramId, deviceId, newName) {
        try {
            await client.connect();
            const db = client.db(dbName);

            await db.collection('users').updateOne(
                { _id: telegramId, "devices.device_id": deviceId },
                { $set: { "devices.$.custom_name": newName } }
            );

            return { success: true };
        } catch (err) {
            console.error('Ошибка обновления имени устройства:', err);
            return { success: false, error: err.message };
        }
    }

    static async updateDeviceSettings(telegramId, deviceId, settings) {
        try {
            await client.connect();
            const db = client.db(dbName);

            await db.collection('users').updateOne(
                { _id: telegramId, "devices.device_id": deviceId },
                { $set: { "devices.$.settings": settings } }
            );

            return { success: true };
        } catch (err) {
            console.error('Ошибка обновления настроек устройства:', err);
            return { success: false, error: err.message };
        }
    }

    static groupDevicesByType(devices) {
        const grouped = {};

        devices.forEach(device => {
            if (!grouped[device.device_type]) {
                grouped[device.device_type] = {
                    type_info: DEVICE_TYPES[device.device_type],
                    devices: []
                };
            }
            grouped[device.device_type].devices.push(device);
        });

        return grouped;
    }
}

// 2.2 Сервис для работы с устройствами
class DeviceService {
    static getDeviceType(deviceId) {
        const deviceConfig = VALID_DEVICES[deviceId];
        return deviceConfig ? deviceConfig.type : null;
    }

    static isValidDevice(deviceId) {
        return VALID_DEVICES.hasOwnProperty(deviceId);
    }

    static validateSettings(deviceType, settings) {
        const typeConfig = DEVICE_TYPES[deviceType];
        if (!typeConfig) return { valid: false, error: 'Неизвестный тип устройства' };

        const validation = typeConfig.validation;
        for (const [key, value] of Object.entries(settings)) {
            if (validation[key]) {
                const rule = validation[key];
                if (rule.type === 'number') {
                    if (value < rule.min || value > rule.max) {
                        return { valid: false, error: `${key} должен быть между ${rule.min} и ${rule.max}` };
                    }
                }
            }
        }

        return { valid: true };
    }

    static async checkDeviceOwnership(telegramId, deviceId) {
        const user = await UserService.getUser(telegramId);
        if (!user || !user.devices) return false;

        return user.devices.some(device => device.device_id === deviceId);
    }
}

// ============================================================================
// ФАЗА 3: MQTT СИСТЕМА
// ============================================================================

// 3.1 MQTT настройки
const mqttOptions = {
    host: process.env.MQTT_SERVER,
    port: Number(process.env.MQTT_PORT),
    username: process.env.MQTT_USER,
    password: process.env.MQTT_PASSWORD,
    protocol: 'mqtt'
};

// 3.2 Класс для управления MQTT устройствами
class MQTTDeviceManager {
    constructor() {
        this.client = mqtt.connect(mqttOptions);
        this.latestData = new Map(); // device_id -> latest data
        this.deviceHandlers = new Map();
        this.setupConnection();
        this.registerDeviceTypes();
    }

    setupConnection() {
        this.client.on('connect', () => {
            console.log('🔌 MQTT connected');
            this.subscribeToAllDevices();
        });

        this.client.on('message', (topic, message) => {
            this.handleMessage(topic, message);
        });
    }

    registerDeviceTypes() {
        // Регистрируем handlers для каждого типа устройств
        Object.keys(DEVICE_TYPES).forEach(deviceType => {
            this.deviceHandlers.set(deviceType, new DeviceTypeHandler(deviceType));
        });
    }

    subscribeToAllDevices() {
        Object.keys(VALID_DEVICES).forEach(deviceId => {
            const deviceType = VALID_DEVICES[deviceId].type;
            const typeConfig = DEVICE_TYPES[deviceType];

            Object.values(typeConfig.mqttTopics).forEach(topicTemplate => {
                const topic = topicTemplate.replace('{device_id}', deviceId);
                this.client.subscribe(topic);
            });
        });
    }

    handleMessage(topic, message) {
        const deviceId = this.extractDeviceId(topic);
        if (!deviceId) return;

        try {
            const payload = JSON.parse(message.toString());
            this.latestData.set(deviceId, {
                ...payload,
                timestamp: new Date(),
                device_id: deviceId
            });
        } catch (e) {
            console.error('Ошибка парсинга MQTT:', e);
        }
    }

    extractDeviceId(topic) {
        const match = topic.match(/devices\/([^\/]+)\//);
        return match ? match[1] : null;
    }

    getLatestData(deviceId) {
        return this.latestData.get(deviceId) || {};
    }

    publishCommand(deviceId, command, data) {
        const deviceType = DeviceService.getDeviceType(deviceId);
        if (!deviceType) return false;

        const typeConfig = DEVICE_TYPES[deviceType];
        const topicTemplate = typeConfig.mqttTopics[command];

        if (!topicTemplate) return false;

        const topic = topicTemplate.replace('{device_id}', deviceId);
        this.client.publish(topic, String(data));
        return true;
    }
}

// 3.3 Handler для типов устройств
class DeviceTypeHandler {
    constructor(deviceType) {
        this.deviceType = deviceType;
        this.config = DEVICE_TYPES[deviceType];
    }

    // Дополнительная логика для каждого типа устройств
    // Будет расширяться в будущем
}

// ============================================================================
// ФАЗА 4: MIDDLEWARE И ВАЛИДАЦИЯ
// ============================================================================

// 4.1 Middleware для проверки авторизации
const requireAuth = (req, res, next) => {
    const telegramId = req.body?.telegram_id || req.query?.telegram_id;

    // console.log('📡 [AUTH] Получен telegram_id:', telegramId);
    // console.log('📦 req.body =', req.body);
    // console.log('📦 req.query =', req.query);

    if (!telegramId) {
        return res.status(401).json({ error: 'Требуется авторизация' });
    }

    req.telegramId = telegramId;
    next();
};


// 4.2 Middleware для валидации устройств
// 4.2 Middleware для валидации устройств
const validateDevice = (req, res, next) => {
    // Ищем device_id в разных местах в зависимости от типа запроса
    const device_id = req.params.device_id || req.body?.device_id || req.query?.device_id;

    // console.log('📡 [VALIDATE_DEVICE] Поиск device_id:', {
    //     method: req.method,
    //     url: req.url,
    //     params: req.params,
    //     body: req.body,
    //     query: req.query,
    //     found_device_id: device_id
    // });

    if (!device_id) {
        console.log('❌ [VALIDATE_DEVICE] device_id не найден');
        return res.status(400).json({ error: 'Не указан device_id' });
    }

    if (!DeviceService.isValidDevice(device_id)) {
        console.log('❌ [VALIDATE_DEVICE] Неверный device_id:', device_id);
        return res.status(400).json({ error: 'Неверный ID устройства' });
    }

    // console.log('✅ [VALIDATE_DEVICE] device_id валиден:', device_id);
    req.deviceId = device_id;
    req.deviceType = DeviceService.getDeviceType(device_id);
    next();
};

// 4.3 Middleware для проверки владельца устройства
const requireDeviceOwnership = async (req, res, next) => {
    const hasAccess = await DeviceService.checkDeviceOwnership(req.telegramId, req.deviceId);
    if (!hasAccess) {
        return res.status(403).json({ error: 'Нет доступа к устройству' });
    }
    next();
};

// ============================================================================
// ФАЗА 5: API ENDPOINTS
// ============================================================================

// Инициализация MQTT менеджера
const mqttManager = new MQTTDeviceManager();

// Middleware
app.use(cors());
app.use(express.json());

// 5.1 Системные endpoints
// app.get('/ping', (req, res) => {
//     console.log('🔄 Ping received at', new Date());
//     res.json({ status: 'alive', timestamp: new Date() });
// });

app.get('/api/devices/types', (req, res) => {
    res.json(DEVICE_TYPES);
});

// 5.2 Авторизация и управление устройствами
app.post('/api/auth/register-device', requireAuth, validateDevice, async (req, res) => {
    const { device_id, username, first_name, last_name } = req.body;
    const telegramId = req.telegramId;

    try {
        // Проверяем, не занято ли устройство
        const existingUsers = await client.db(dbName).collection('users')
            .find({ "devices.device_id": device_id }).toArray();

        const occupiedBy = existingUsers.find(user => user._id !== telegramId);
        if (occupiedBy) {
            return res.status(400).json({ error: 'Устройство уже привязано к другому пользователю' });
        }

        // Проверяем, не добавлено ли уже это устройство текущим пользователем
        const user = await UserService.getUser(telegramId);
        if (user && user.devices && user.devices.some(d => d.device_id === device_id)) {
            return res.status(400).json({ error: 'Устройство уже добавлено' });
        }

        // Добавляем устройство
        const result = await UserService.addDevice(telegramId, device_id, {
            username, first_name, last_name
        });

        if (result.success) {
            console.log(`✅ Устройство ${device_id} добавлено пользователю ${telegramId}`);
            res.json({
                success: true,
                message: 'Устройство успешно добавлено',
                device: result.device
            });
        } else {
            res.status(500).json({ error: result.error });
        }

    } catch (err) {
        console.error('Ошибка регистрации устройства:', err);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

app.get('/api/auth/check', requireAuth, async (req, res) => {
    try {
        const user = await UserService.getUser(req.telegramId);

        if (user && user.devices && user.devices.length > 0) {
            const groupedDevices = UserService.groupDevicesByType(user.devices);
            // console.log("Grouped Devices = ", JSON.stringify(groupedDevices, null, 2));
            res.json({
                authorized: true,
                devices: groupedDevices,
                total_devices: user.devices.length
            });
        } else {
            res.json({ authorized: false });
        }
    } catch (err) {
        console.error('Ошибка проверки авторизации:', err);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// 5.3 Управление конкретными устройствами
app.get('/api/devices/:device_id/data', requireAuth, validateDevice, requireDeviceOwnership, (req, res) => {
    console.log('Запрос данных устройства:', {
        deviceId: req.deviceId,
        telegramId: req.telegramId,
        userAgent: req.headers['user-agent'],
        ip: req.ip
    });

    const data = mqttManager.getLatestData(req.deviceId);
    res.json(data);
});

app.put('/api/devices/:device_id/settings', requireAuth, validateDevice, requireDeviceOwnership, async (req, res) => {
    const { settings } = req.body;

    // Валидируем настройки
    const validation = DeviceService.validateSettings(req.deviceType, settings);
    if (!validation.valid) {
        return res.status(400).json({ error: validation.error });
    }

    try {
        // Сохраняем в базу
        const result = await UserService.updateDeviceSettings(req.telegramId, req.deviceId, settings);

        if (result.success) {
            // Отправляем команды через MQTT
            Object.entries(settings).forEach(([key, value]) => {
                mqttManager.publishCommand(req.deviceId, key, value);
            });

            res.json({ success: true, message: 'Настройки обновлены' });
        } else {
            res.status(500).json({ error: result.error });
        }
    } catch (err) {
        console.error('Ошибка обновления настроек:', err);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

app.put('/api/devices/:device_id/name', requireAuth, validateDevice, requireDeviceOwnership, async (req, res) => {
    const { name } = req.body;

    if (!name || name.trim().length === 0) {
        return res.status(400).json({ error: 'Название не может быть пустым' });
    }

    try {
        const result = await UserService.updateDeviceName(req.telegramId, req.deviceId, name.trim());

        if (result.success) {
            res.json({ success: true, message: 'Название обновлено' });
        } else {
            res.status(500).json({ error: result.error });
        }
    } catch (err) {
        console.error('Ошибка обновления названия:', err);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

app.post('/api/auth/unregister-device', requireAuth, validateDevice, requireDeviceOwnership, async (req, res) => {
    try {
        const result = await UserService.removeDevice(req.telegramId, req.deviceId);

        if (result.success) {
            console.log(`🔓 Устройство ${req.deviceId} отвязано от пользователя ${req.telegramId}`);
            res.json({ success: true, message: 'Устройство отвязано' });
        } else {
            res.status(500).json({ error: result.error });
        }
    } catch (err) {
        console.error('Ошибка отвязки устройства:', err);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// ============================================================================
// ФАЗА 6: LEGACY ENDPOINTS (для совместимости)
// ============================================================================

// 6.1 Поддержка старых endpoints (временно)
app.post('/register', requireAuth, validateDevice, async (req, res) => {
    console.log('⚠️  Используется устаревший endpoint /register');
    const { device_id, username, first_name, last_name } = req.body;
    const telegramId = req.telegramId;

    try {
        const existingUsers = await client.db(dbName).collection('users')
            .find({ "devices.device_id": device_id }).toArray();

        const occupiedBy = existingUsers.find(user => user._id !== telegramId);
        if (occupiedBy) {
            return res.status(400).json({ error: 'Устройство уже привязано к другому пользователю' });
        }

        const user = await UserService.getUser(telegramId);
        if (user && user.devices && user.devices.some(d => d.device_id === device_id)) {
            return res.status(400).json({ error: 'Устройство уже добавлено' });
        }

        const result = await UserService.addDevice(telegramId, device_id, {
            username, first_name, last_name
        });

        if (result.success) {
            console.log(`✅ Устройство ${device_id} добавлено пользователю ${telegramId}`);
            res.json({
                success: true,
                message: 'Устройство успешно добавлено',
                device: result.device
            });
        } else {
            res.status(500).json({ error: result.error });
        }

    } catch (err) {
        console.error('Ошибка регистрации устройства:', err);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

app.get('/check-auth', requireAuth, async (req, res) => {
    console.log('⚠️  Используется устаревший endpoint /check-auth');
    try {
        const user = await UserService.getUser(req.telegramId);

        if (user && user.devices && user.devices.length > 0) {
            const groupedDevices = UserService.groupDevicesByType(user.devices);
            console.log("Grouped Devices = ", JSON.stringify(groupedDevices, null, 2));
            res.json({
                authorized: true,
                devices: groupedDevices,
                total_devices: user.devices.length
            });
        } else {
            res.json({ authorized: false });
        }
    } catch (err) {
        console.error('Ошибка проверки авторизации:', err);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// 6.2 Временные endpoints для совместимости с старым фронтендом
app.get('/get-latest', (req, res) => {
    console.log('⚠️  Используется устаревший endpoint /get-latest');
    const { device_id } = req.query;
    if (!device_id) {
        return res.status(400).json({ error: 'Не указан device_id' });
    }
    const data = mqttManager.getLatestData(device_id);
    res.json(data);
});

app.post('/set-threshold', (req, res) => {
    console.log('⚠️  Используется устаревший endpoint /set-threshold');
    const { threshold, device_id } = req.body;

    if (!device_id || !VALID_DEVICES[device_id]) {
        return res.status(400).json({ error: 'Неверный device_id' });
    }

    // ДОБАВИТЬ ВАЛИДАЦИЮ:
    if (threshold === undefined || threshold === null || isNaN(threshold)) {
        return res.status(400).json({ error: 'Неверное значение порога' });
    }

    const numericThreshold = Number(threshold);
    if (numericThreshold < 0 || numericThreshold > 40) {
        return res.status(400).json({ error: 'Порог должен быть между 0 и 40' });
    }

    const success = mqttManager.publishCommand(device_id, 'threshold', numericThreshold);

    if (success) {
        console.log(`🌡️ Установлен порог ${numericThreshold}°C для устройства ${device_id}`);
        res.json({ ok: true });
    } else {
        res.status(500).json({ error: 'Ошибка отправки команды' });
    }
});

// ============================================================================
// ЗАПУСК СЕРВЕРА
// ============================================================================

app.listen(PORT, () => {
    console.log(`🚀 IoT Hub Server running on port ${PORT}`);
    console.log(`📱 Поддерживаемые типы устройств: ${Object.keys(DEVICE_TYPES).join(', ')}`);
    console.log(`🔧 Доступные устройства: ${Object.keys(VALID_DEVICES).length}`);
});

// ============================================================================
// ПЛАНЫ РАЗВИТИЯ
// ============================================================================

/*
СЛЕДУЮЩИЕ ЭТАПЫ РАЗРАБОТКИ:

1. ФАЗА 7: Система уведомлений
   - Telegram Bot для отправки уведомлений
   - Настройка алертов для каждого устройства
   - История событий

2. ФАЗА 8: Статистика и аналитика
   - Сбор исторических данных
   - Графики и отчеты
   - Экспорт данных

3. ФАЗА 9: Расширенные возможности
   - Планировщик задач
   - Автоматизация (if-then правила)
   - Группировка устройств

4. ФАЗА 10: Мониторинг и безопасность
   - Логирование действий
   - Система ролей
   - Аудит безопасности

5. ФАЗА 11: Масштабирование
   - Кластеризация
   - Кеширование (Redis)
   - Оптимизация производительности
*/