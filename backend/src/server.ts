import express from 'express';
import http from 'http';
import { Server, Socket } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import { SocketGateway } from '../../dialogue/gateway_core/SocketGateway';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT || 3001;

// Instantiate the modular SocketGateway
const gateway = new SocketGateway(io);
gateway.init();

server.listen(PORT, () => {
  console.log(`AI Vision Dialogue Gateway running on port ${PORT}`);
});
