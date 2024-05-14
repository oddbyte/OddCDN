const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const zlib = require('zlib');
const crypto = require('crypto');
const os = require('os');
const cluster = require('cluster');
const winston = require('winston');
require('winston-daily-rotate-file');

/*
    Author: Oddbyte
    Description: The port number the server will listen on.
*/
const PORT = 6060;
/*
    Author: Oddbyte
    Description: The root directory to serve static files from.
*/
const ROOT_DIR = path.resolve(__dirname, 'public');
/*
    Author: Oddbyte
    Description: In-memory cache for storing compressed file data.
*/
const CACHE = new Map();
/*
    Author: Oddbyte
    Description: The maximum cache size in bytes (1GB).
*/
const MAX_CACHE_SIZE = 1 * 1024 * 1024 * 1024;
/*
    Author: Oddbyte
    Description: The current size of the cache.
*/
let cacheSize = 0;
/*
    Author: Oddbyte
    Description: The maximum log directory size in bytes (5GB).
*/
const MAX_LOG_DIR_SIZE = 5 * 1024 * 1024 * 1024;

/*
    Author: Oddbyte
    Description: Log directory and logger setup.
*/
const logDir = './log';
if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir);
}

const dailyRotateFileTransport = new winston.transports.DailyRotateFile({
    filename: `${logDir}/%DATE%.log`,
    datePattern: 'YYYY-MM-DD',
    zippedArchive: true,
    maxSize: '250m',  // 250 MB
    maxFiles: '365d'  // Keep logs for 1 year
});

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.Console(),
        dailyRotateFileTransport
    ]
});

/*
    Author: Oddbyte
    Description: Function to get the size of a directory.
    Params:
        directory - The directory path.
    Returns: The size of the directory in bytes.
*/
const getDirectorySize = (directory) => {
    const files = fs.readdirSync(directory);
    let totalSize = 0;

    files.forEach(file => {
        const filePath = path.join(directory, file);
        const stats = fs.statSync(filePath);
        if (stats.isFile()) {
            totalSize += stats.size;
        }
    });

    return totalSize;
};

/*
    Author: Oddbyte
    Description: Function to enforce log directory size limit.
*/
const enforceLogSizeLimit = () => {
    let totalSize = getDirectorySize(logDir);
    if (totalSize <= MAX_LOG_DIR_SIZE) {
        return;
    }

    const files = fs.readdirSync(logDir)
        .map(file => ({ file, time: fs.statSync(path.join(logDir, file)).mtime.getTime() }))
        .sort((a, b) => a.time - b.time);

    for (const { file } of files) {
        if (totalSize <= MAX_LOG_DIR_SIZE) {
            break;
        }

        const filePath = path.join(logDir, file);
        const stats = fs.statSync(filePath);
        fs.unlinkSync(filePath);
        totalSize -= stats.size;
    }
};

/*
    Author: Oddbyte
    Description: MIME types mapping for different file extensions.
*/
const MIME_TYPES = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.json': 'application/json',
    '.txt': 'text/plain',
    '.xml': 'application/xml',
    '.pdf': 'application/pdf',
    '.mp4': 'video/mp4',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.eot': 'application/vnd.ms-fontobject',
    '.otf': 'font/otf',
    '.webp': 'image/webp',
    '.webm': 'video/webm',
    '.ogg': 'audio/ogg',
    '.ogv': 'video/ogg'
};

/*
    Author: Oddbyte
    Description: Generate an ETag for the given file content.
    Params:
        data - The file content to generate an ETag for.
    Returns: A string representing the ETag.
*/
const generateETag = (data) => crypto.createHash('md5').update(data).digest('hex');

/*
    Author: Oddbyte
    Description: Evict the oldest entries from the cache until it is within the maximum size limit.
*/
const evictCache = () => {
    while (cacheSize > MAX_CACHE_SIZE) {
        const oldestKey = CACHE.keys().next().value;
        const oldestEntry = CACHE.get(oldestKey);
        cacheSize -= oldestEntry.size;
        CACHE.delete(oldestKey);
    }
};

/*
    Author: Oddbyte
    Description: Send an HTTP response with the given status code, headers, and data.
    Params:
        res - The HTTP response object.
        statusCode - The HTTP status code to send.
        headers - The headers to send with the response.
        data - The data to send in the response body.
*/
const sendResponse = (res, statusCode, headers, data) => {
    res.writeHead(statusCode, headers);
    res.end(data);
};

/*
    Author: Oddbyte
    Description: Send an HTTP error response with the given status code and message.
    Params:
        res - The HTTP response object.
        statusCode - The HTTP status code to send.
        message - The error message to send in the response body.
*/
const sendError = (res, statusCode, message) => {
    const headers = { 'Content-Type': 'text/plain' };
    res.writeHead(statusCode, headers);
    res.end(message);
};

/*
    Author: Oddbyte
    Description: Log an HTTP request with the given status code.
    Params:
        req - The HTTP request object.
        statusCode - The HTTP status code to log.
*/
const logRequest = (req, statusCode) => {
    const now = new Date();
    const logEntry = {
        timestamp: now.toISOString(),
        method: req.method,
        url: req.url,
        statusCode
    };
    logger.info(logEntry);
};

/*
    Author: Oddbyte
    Description: Cache the given file data with the associated headers.
    Params:
        pathname - The file path to cache.
        data - The file data to cache.
        headers - The headers associated with the cached data.
*/
const cacheFile = (pathname, data, headers) => {
    const compressedData = zlib.gzipSync(data);
    const entry = {
        headers,
        content: compressedData,
        size: compressedData.length
    };
    CACHE.set(pathname, entry);
    cacheSize += entry.size;
    evictCache();
};

/*
    Author: Oddbyte
    Description: Check if the given child path is a subdirectory of the parent path.
    Params:
        parent - The parent directory path.
        child - The child directory path to check.
    Returns: True if the child is a subdirectory of the parent, false otherwise.
*/
const isSubdirectory = (parent, child) => {
    const relative = path.relative(parent, child);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
};

/*
    Author: Oddbyte
    Description: Serve a directory listing.
    Params:
        req - The HTTP request object.
        res - The HTTP response object.
        pathname - The directory path to list.
*/
const serveDirectory = (req, res, pathname) => {
    fs.readdir(pathname, (err, files) => {
        if (err) {
            logRequest(req, 500);
            sendError(res, 500, `Error reading directory: ${err}.`);
            return;
        }
        const fileList = files.map(file => `<li><a href="${path.join(req.url, file)}">${file}</a></li>`).join('');
        const content = `<html><body><ul>${fileList}</ul></body></html>`;
        const headers = {
            'Content-Type': 'text/html',
            'Content-Length': Buffer.byteLength(content)
        };
        logRequest(req, 200);
        sendResponse(res, 200, headers, content);
    });
};

/*
    Author: Oddbyte
    Description: Handle incoming HTTP requests and serve static files.
    Params:
        req - The HTTP request object.
        res - The HTTP response object.
*/
const handleRequest = (req, res) => {
    try {
        const parsedUrl = url.parse(req.url);
        let pathname = path.join(ROOT_DIR, parsedUrl.pathname);
        pathname = path.normalize(pathname);

        if (!isSubdirectory(ROOT_DIR, pathname)) {
            logRequest(req, 403);
            sendError(res, 403, 'Forbidden: Directory traversal attempt detected.');
            return;
        }

        if (fs.existsSync(pathname) && fs.statSync(pathname).isDirectory()) {
            pathname = path.join(pathname, 'index.html');
        }

        fs.stat(pathname, (err, stats) => {
            if (err) {
                logRequest(req, 404);
                sendError(res, 404, `File ${pathname} not found!`);
                return;
            }

            if (stats.isDirectory()) {
                serveDirectory(req, res, pathname);
                return;
            }

            if (stats.isSymbolicLink()) {
                const realPath = fs.realpathSync(pathname);
                if (!isSubdirectory(ROOT_DIR, realPath)) {
                    logRequest(req, 403);
                    sendError(res, 403, 'Forbidden: Symlink points outside the root directory.');
                    return;
                }
            }

            const lastModified = stats.mtime.toUTCString();
            fs.readFile(pathname, (err, data) => {
                if (err) {
                    logRequest(req, 500);
                    sendError(res, 500, `Error getting the file: ${err}.`);
                    return;
                }

                const etag = generateETag(data);

                if (req.headers['if-none-match'] === etag) {
                    logRequest(req, 304);
                    sendResponse(res, 304, { 'ETag': etag });
                    return;
                }

                if (req.headers['if-modified-since'] === lastModified) {
                    logRequest(req, 304);
                    sendResponse(res, 304, { 'Last-Modified': lastModified });
                    return;
                }

                const ext = path.extname(pathname).toLowerCase();
                const mimeType = MIME_TYPES[ext] || 'application/octet-stream';
                const headers = {
                    'Content-Type': mimeType,
                    'Content-Encoding': 'gzip',
                    'Cache-Control': 'public, max-age=3600',
                    'X-Content-Type-Options': 'nosniff',
                    'X-Frame-Options': 'DENY',
                    'X-XSS-Protection': '1; mode=block',
                    'ETag': etag,
                    'Last-Modified': lastModified
                };

                cacheFile(pathname, data, headers);

                logRequest(req, 200);
                sendResponse(res, 200, headers, zlib.gzipSync(data));
            });
        });
    } catch (error) {
        logRequest(req, 500);
        sendError(res, 500, `Internal Server Error: ${error.message}`);
    }
};

if (cluster.isMaster) {
    /*
        Author: Oddbyte
        Description: Master process that forks worker processes based on the number of CPU cores.
    */
    console.log(`Master ${process.pid} is running`);

    const numCPUs = os.cpus().length;
    for (let i = 0; i < numCPUs; i++) {
        cluster.fork();
    }

    cluster.on('exit', (worker, code, signal) => {
        console.log(`Worker ${worker.process.pid} died. Forking a new worker...`);
        cluster.fork();
    });

    let shuttingDown = false;

    const handleInput = (data) => {
        const input = data.toString().trim();
        switch (input) {
            case 'stop':
                console.log(`Stopping the server...`);
                shuttingDown = true;
                for (const id in cluster.workers) {
                    cluster.workers[id].kill();
                }
                process.exit(0);
                break;
            case 'verbose on':
                verboseLogging = true;
                console.log(`Verbose mode enabled.`);
                break;
            case 'verbose off':
                verboseLogging = false;
                console.log(`Verbose mode disabled.`);
                break;
            case 'cache clear':
                CACHE.clear();
                cacheSize = 0;
                console.log(`Cache cleared.`);
                break;
            case 'cache list':
                console.log(`Cached items:`);
                for (const [key, value] of CACHE) {
                    console.log(key);
                }
                break;
            case 'help':
                console.log(`Available commands:`);
                console.log(`  stop         - Stop the server`);
                console.log(`  verbose on   - Enable verbose logging`);
                console.log(`  verbose off  - Disable verbose logging`);
                console.log(`  cache clear  - Clear the cache`);
                console.log(`  cache list   - List cached items`);
                break;
            default:
                console.log(`Unknown command: "${input}"`);
                break;
        }
    };

    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', handleInput);

    process.on('SIGTERM', () => {
        shuttingDown = true;
        console.log('Graceful shutdown initiated');
        process.exit(0);
    });

    process.on('SIGINT', () => {
        shuttingDown = true;
        console.log('Graceful shutdown initiated');
        process.exit(0);
    });

    // Enforce log size limit at startup and every 10 minutes
    enforceLogSizeLimit();
    setInterval(enforceLogSizeLimit, 10 * 60 * 1000);

} else {
    /*
        Author: Oddbyte
        Description: Worker process that handles incoming HTTP requests.
    */
    const server = http.createServer(handleRequest);

    server.listen(PORT, () => {
        console.log(`OddCDN worker ${process.pid} running at http://localhost:${PORT}/`);
    });

    const gracefulShutdown = () => {
        console.log('Graceful shutdown initiated');
        server.close(() => {
            console.log('Server closed');
            process.exit(0);
        });
    };

    process.on('SIGTERM', gracefulShutdown);
    process.on('SIGINT', gracefulShutdown);
}
