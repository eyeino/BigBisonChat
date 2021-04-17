const express = require('express');
const cors = require('cors');

const EventEmitter = require('eventemitter3');
const em = new EventEmitter();

const db = require('../db/index');

// JWT for authentication with Auth0
const jwt = require('express-jwt');
const jwksRsa = require('jwks-rsa');
const jwtDecode = require('jwt-decode');

const checkJwt = jwt({
  secret: jwksRsa.expressJwtSecret({
    cache: true,
    rateLimit: true,
    jwksRequestsPerMinute: 5,
    jwksUri: `https://bigbisonchat.auth0.com/.well-known/jwks.json`
  }),

  // Validate the audience and the issuer.
  aud: 'https://bigbisonchat.herokuapp.com',
  issuer: `https://bigbisonchat.auth0.com/`,
  algorithms: ['RS256']
});

const corsOptions = {
  origin: process.env.PORT ? 'https://chat.bigbison.co' : 'http://localhost:3000',
  optionsSuccessStatus: 200
};

// server initialization
const app = express();
const server = require('http').Server(app);
const io = require('socket.io').listen(server);

// middleware
const ignoreFavicon = (req, res, next) => {
  if (req.originalUrl === "/favicon.ico") {
    res.status(204).end();
  } else {
    next();
  }
}

const excludedRoutes = [/\/((?!ping).)*/];

app.use(express.json());
app.use(cors(corsOptions));
app.use(ignoreFavicon);
app.use(excludedRoutes, checkJwt);

// TODO: change this name.. decodeSub is a bit of a misnomer
// since it does more than that
function decodeSubFromRequestHeader(request) {
  const jwt = request.header('authorization').split(" ")[1];
  const decodedJwt = jwtDecode(jwt);
  return {
    sub: decodedJwt.sub,
    username: decodedJwt.nickname,
    picture: decodedJwt.picture
  }
}

// create unique and deterministic event name for a conversation
function determineEventNameFromUsernames(username1, username2) {
  return [username1, username2].sort().join('-');
};

// get list of conversations, with most recent message
app.get('/conversations', async (req, res) => {
  const userInfo = decodeSubFromRequestHeader(req);

  try {
    const userIdResults = await db.readQuery(db.queryStrings.readUserId, [
      userInfo.username
    ]);
    const userId = userIdResults[0]["user_id"];
    const conversations = await db.readQuery(
      db.queryStrings.readConversations,
      [userId]
    );

    res.json(conversations);
    return
  } catch(err) {
    await db.insertQuery(db.queryStrings.insertUser, [userInfo.username, userInfo.sub, userInfo.picture])
    res.redirect(req.originalUrl);
    return
  }
})

// get list of messages between two users
app.get('/conversations/:username', async (req, res) => {

  const userInfo = decodeSubFromRequestHeader(req);
  const userIdResults = await db.readQuery(db.queryStrings.readUserId, [userInfo.username]);
  const userId = userIdResults[0]["user_id"];
  
  const otherUserIdResults = await db.readQuery(db.queryStrings.readUserId, [req.params.username]);
  const otherUserId = otherUserIdResults[0]["user_id"];

  const messages = await db.readQuery(db.queryStrings.readChatMessages, [userId, otherUserId]);
  res.json(messages);
})

// send message to a user from a user
app.post("/conversations/:username", async (req, res) => {
  try {
    const userInfo = decodeSubFromRequestHeader(req);
    const userIdResults = await db.readQuery(db.queryStrings.readUserId, [
      userInfo.username
    ]);
    const userId = userIdResults[0]["user_id"];

    const otherUserIdResults = await db.readQuery(db.queryStrings.readUserId, [
      req.params.username
    ]);

    const otherUserId = otherUserIdResults[0]["user_id"];

    const messageBody = req.body.messageBody;

    const insertedMessageResponse = await db.insertQuery(db.queryStrings.insertMessageAndReturnIt, [
      userId,
      otherUserId,
      messageBody
    ]);

    const eventName = determineEventNameFromUsernames(userInfo.username, req.params.username);

    em.emit('post', eventName, insertedMessageResponse.rows[0]['row_to_json']);

    res.sendStatus(200);
    return;
  } catch (err) {
    res.sendStatus(400);
    return;
  }
});

app.get('/search/users/:query', async (req, res) => {
  const usernameQuery = req.params.query;

  const usernameResults = await db.readQuery(db.queryStrings.readUserSearchResults, [usernameQuery + '%']);
  res.json(usernameResults);
});

app.get("/ping", (_req, res) => {
  res.sendStatus(200);
});

app.get("*", (_req, res) => {
  res.sendStatus(404);
});

io.on('connection', socket => {
  em.on('post', (eventName, payload) => {
    socket.emit(eventName, payload);
  });
})

port = process.env.PORT || 8080;
server.listen(port, async () => {
  console.log(`server listening on port ${port}`);
});