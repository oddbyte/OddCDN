const cluster = require('cluster');
const net = require('net');
const os = require('os');
const numCPUs = os.cpus().length;
const PORT = 6060;

if (cluster.isMaster) {
    console.log(`Master ${process.pid} is running`);

    // Fork workers
    for (let i = 0; i < numCPUs; i++) {
        cluster.fork();
    }

    let workers = Object.values(cluster.workers);

    // Round-robin balancing
    let currentWorker = 0;

    const server = net.createServer({ pauseOnConnect: true }, (connection) => {
        console.log('Master received a connection');
        const worker = workers[currentWorker];
        worker.send('sticky-session:connection', connection);
        currentWorker = (currentWorker + 1) % workers.length;
    });

    server.listen(PORT, () => {
        console.log(`Master process is listening on port ${PORT}`); // Master, like sla-- wait I can't make that joke.
    });

    cluster.on('exit', (worker, code, signal) => {
        console.log(`Worker ${worker.process.pid} died`);
        const newWorker = cluster.fork();
        workers = Object.values(cluster.workers);
    });

} else {
    require('./worker.js');
}
