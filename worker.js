const express = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { getFromCache, setInCache, invalidateCache, calculateFileHash } = require('./cache.js');
const escapeHtml = require('escape-html'); // For sanitizing strings

const app = express();

const ROOT_PATH = path.join(__dirname, 'public');

// Function to truncate and sanitize path
const getTruncatedPath = (fullPath) => {
    return fullPath.replace(ROOT_PATH, '').replace(/\\/g, '/');
};

// Function to sanitize filenames and paths
const sanitize = (str) => {
    return escapeHtml(str);
};

// Serve static files from the 'public' directory
app.use(express.static(ROOT_PATH));

// Middleware for caching
app.use(async (req, res, next) => {
    const key = req.originalUrl;
    const requestedPath = path.join(ROOT_PATH, req.path);

    try {
        const stats = await fs.promises.stat(requestedPath);

        if (stats.isDirectory()) {
            return next();
        }

        const cachedResponse = getFromCache(key);

        if (cachedResponse) {
            res.send(cachedResponse.value);
        } else {
            res.sendResponse = res.send;
            res.send = async (body) => {
                await setInCache(key, body, requestedPath);
                res.sendResponse(body);
            };
            next();
        }
    } catch (err) {
        next(err);
    }
});

// Dynamic index generation for all folders
app.use(async (req, res, next) => {
    const requestedPath = path.join(ROOT_PATH, req.path);

    try {
        const stats = await fs.promises.stat(requestedPath);

        if (stats.isDirectory()) {
            const files = await fs.promises.readdir(requestedPath);

            const fileLinks = files.map(file => {
                const sanitizedFile = sanitize(file);
                const filePath = path.join(req.path, sanitizedFile).replace(/\\/g, '/');
                return `<li><a href="${filePath}">${sanitizedFile}</a></li>`;
            }).join('');

            const indexPath = path.join(__dirname, 'index.html');
            let data = await fs.promises.readFile(indexPath, 'utf8');

            const sanitizedDirPath = sanitize(getTruncatedPath(req.path));
            data = data.replace(/{{dirPath}}/g, sanitizedDirPath).replace(/{{fileLinks}}/g, fileLinks);
            
            res.send(data);
        } else {
            next();
        }
    } catch (err) {
        next(err);
    }
});

// Worker handling incoming connections
const server = http.createServer(app);
process.on('message', (message, connection) => {
    if (message === 'sticky-session:connection') {
        console.log(`Worker ${process.pid} received a connection`);
        server.emit('connection', connection);
        connection.resume();
    }
});

server.listen(0, () => {
    console.log(`Worker ${process.pid} started and listening`); // Worker not "slave" 100% guys idk what you're talking about.
});
