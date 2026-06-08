const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Message = require('../models/Message');
const Room = require('../models/Room');

const roomUsers = {};

const getRoomUsers = (roomId) => {
  return (roomUsers[roomId] || []).map(({ username, userId, avatarColor }) => ({
    username,
    userId,
    avatarColor,
  }));
};

const authenticateSocket = async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Authentication required'));

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select('-password');
    if (!user) return next(new Error('User not found'));

    socket.user = {
      userId: user._id.toString(),
      username: user.username,
      avatarColor: user.avatarColor,
    };
    next();
  } catch (err) {
    next(new Error('Invalid token'));
  }
};

const handleSocketEvents = (io) => {
  io.use(authenticateSocket);

  io.on('connection', (socket) => {
    console.log(`✅ ${socket.user.username} connected [${socket.id}]`);

    socket.on('joinRoom', async ({ roomId }) => {
      try {
        const previousRooms = [...socket.rooms].filter((r) => r !== socket.id);
        previousRooms.forEach((prevRoom) => {
          if (roomUsers[prevRoom]) {
            roomUsers[prevRoom] = roomUsers[prevRoom].filter(
              (u) => u.socketId !== socket.id
            );
            io.to(prevRoom).emit('onlineUsers', getRoomUsers(prevRoom));
          }
          socket.leave(prevRoom);
        });

        const room = await Room.findById(roomId);
        if (!room) return socket.emit('error', { message: 'Room not found' });

        socket.join(roomId);

        if (!roomUsers[roomId]) roomUsers[roomId] = [];
        roomUsers[roomId] = roomUsers[roomId].filter(
          (u) => u.userId !== socket.user.userId
        );
        roomUsers[roomId].push({ socketId: socket.id, ...socket.user });

        await Room.findByIdAndUpdate(roomId, {
          $addToSet: { members: socket.user.userId },
        });

        io.to(roomId).emit('onlineUsers', getRoomUsers(roomId));

        const systemMsg = {
          _id: Date.now().toString(),
          room: roomId,
          sender: null,
          senderUsername: 'System',
          content: `${socket.user.username} joined the room`,
          messageType: 'system',
          createdAt: new Date().toISOString(),
        };
        io.to(roomId).emit('message', systemMsg);

      } catch (err) {
        console.error('joinRoom error:', err);
        socket.emit('error', { message: 'Failed to join room' });
      }
    });

    socket.on('chatMessage', async ({ roomId, content }) => {
      try {
        if (!content || !content.trim()) return;
        if (content.trim().length > 1000) return;

        const message = await Message.create({
          room: roomId,
          sender: socket.user.userId,
          senderUsername: socket.user.username,
          senderAvatarColor: socket.user.avatarColor,
          content: content.trim(),
        });

        const messagePayload = {
          _id: message._id.toString(),
          room: roomId,
          sender: socket.user.userId,
          senderUsername: socket.user.username,
          senderAvatarColor: socket.user.avatarColor,
          content: message.content,
          messageType: 'text',
          createdAt: message.createdAt.toISOString(),
        };

        io.to(roomId).emit('message', messagePayload);

      } catch (err) {
        console.error('chatMessage error:', err);
        socket.emit('error', { message: 'Failed to send message' });
      }
    });

    socket.on('typing', ({ roomId, isTyping }) => {
      socket.to(roomId).emit('typing', {
        username: socket.user.username,
        isTyping,
      });
    });

    socket.on('disconnect', () => {
      console.log(`❌ ${socket.user.username} disconnected`);

      Object.keys(roomUsers).forEach((roomId) => {
        const wasInRoom = roomUsers[roomId].some((u) => u.socketId === socket.id);
        if (wasInRoom) {
          roomUsers[roomId] = roomUsers[roomId].filter(
            (u) => u.socketId !== socket.id
          );

          io.to(roomId).emit('onlineUsers', getRoomUsers(roomId));

          io.to(roomId).emit('message', {
            _id: Date.now().toString(),
            room: roomId,
            sender: null,
            senderUsername: 'System',
            content: `${socket.user.username} left the room`,
            messageType: 'system',
            createdAt: new Date().toISOString(),
          });
        }
      });
    });
  });
};

module.exports = { handleSocketEvents };