const NodeCache = require('node-cache');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const cache = new NodeCache({ stdTTL: 300, checkperiod: 120 });

// Function to calculate file hash
const calculateFileHash = (filePath) => {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);

        stream.on('data', (data) => hash.update(data));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', (err) => reject(err));
    });
};

const getFromCache = (key) => {
    const data = cache.get(key);
    if (data) {
        console.log(`Cache hit for key: ${key}`);
    } else {
        console.log(`Cache miss for key: ${key}`);
    }
    return data;
};

const setInCache = async (key, value, filePath) => {
    try {
        const fileHash = await calculateFileHash(filePath);
        cache.set(key, { value, fileHash });
        console.log(`Cache set for key: ${key}`);
    } catch (err) {
        console.error(`Error setting cache for key: ${key}`, err);
    }
};

const invalidateCache = (key) => {
    cache.del(key);
    console.log(`Cache invalidated for key: ${key}`);
};

// Periodically check and invalidate cache if file has changed
const checkCacheForChanges = () => {
    const keys = cache.keys();
    keys.forEach(async (key) => {
        const cachedItem = cache.get(key);
        if (cachedItem) {
            const { fileHash } = cachedItem;
            const filePath = path.join(__dirname, 'public', key);
            try {
                const currentHash = await calculateFileHash(filePath);
                if (fileHash !== currentHash) {
                    invalidateCache(key);
                }
            } catch (err) {
                console.error(`Error checking cache for key: ${key}`, err);
            }
        }
    });
};

// Check for file changes every 30 seconds
setInterval(checkCacheForChanges, 30000);

module.exports = { getFromCache, setInCache, invalidateCache, calculateFileHash };
