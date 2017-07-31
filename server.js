var app = require('express')()
  , server = require('http').Server(app)
  , io = require('socket.io')(server)
  , _ = require('underscore')
  , prevTs = 0
  , Entity = require('./entity.js')

var port = process.env.PORT || 8000
server.listen(port);
console.log("Listening on port " + port)

// Simple ring-like data structure to hold spawn points
var createRingBuffer = function(length) {
    var pointer = 0, buffer = []

    return {
        push: function(item) {
            buffer[pointer] = item
            pointer = (length + pointer + 1) % length
        }
      , get: function() {
            var tmpPointer = pointer
            pointer = (length + pointer + 1) % length
            return buffer[tmpPointer]
        }
    }
}

/*
 * Check for and handle collisions between a ball and a paddle
 */
var checkCollision = function(b, p) {
    if (b.right <= p.left) {
        return
    }

    if (b.left >= p.right) {
        return
    }

    if (b.bottom <= p.top) {
        return
    }

    if (b.top >= p.bottom) {
        return
    }

    // objects have collided!
    // Handle x axis
    var maxXoverlap = Math.abs(b.dx()) + Math.abs(p.dx())
    var xOverlap = 0

    if (b.dx() > p.dx()) {
        // ball is moving to the right, paddle is moving left or to the right, slower than the ball
        xOverlap = b.right - p.left
        if (xOverlap > maxXoverlap) {
            // overlap is too big to be a collision here.  Look elsewhere.
            xOverlap = 0
        }
    } else if (b.dx() < p.dx()) {
        // ball is moving to the left, paddle is moving right or to the left, slower than the ball
        xOverlap = b.left - p.right
        if (-xOverlap > maxXoverlap) {
            // overlap is too big to be a collision here.  Look elsewhere.
            xOverlap = 0
        }
    }

    if (xOverlap !== 0) {
        // move the ball out of the xOverlap
        b.setX(b.x - xOverlap)
        // reverse x direction of the ball.  The paddle has infinite mass and is unaffected.
        b.vx = -b.vx
    }

    // Handle y axis.  Easier since paddle has no y axis movement
    var maxYoverlap = Math.abs(b.dy())
    var yOverlap = 0

    if (b.dy() < 0) {
        // ball is moving up
        yOverlap = b.top - p.bottom
        if (yOverlap > maxYoverlap) {
            // overlap is too big to be a collision here.  Look elsewhere.
            yOverlap = 0
        }
    } else if (b.dy() > 0) {
        // ball is moving down
        yOverlap = b.bottom - p.top
        if (-yOverlap > maxYoverlap) {
            // overlap is too big to be a collision here.  Look elsewhere.
            yOverlap = 0
        }
    }

    if (yOverlap !== 0) {
        // move the ball out of the yOverlap
        b.setY(b.y - yOverlap)
        // reverse y direction of the ball.  The paddle has infinite mass and is unaffected.
        b.vy = -b.vy
    }
}

// Need to keep game object dimensions, locations, and velocity for physics
var PADDLE_WIDTH = 100
var PADDLE_HEIGHT = 20
var BALL_WIDTH = 20
var BALL_HEIGHT = 20
var GAME_WIDTH = 640
var GAME_HEIGHT = 640
var PLAYER_OFFSET = 40

// setup the player spawn positionss (y coordinate only)
var spawnPoints = createRingBuffer(2)
spawnPoints.push(0 + PLAYER_OFFSET)
spawnPoints.push(GAME_HEIGHT - PLAYER_OFFSET)


// Use the variables to denote player state
var DISCONNECTED = 0
var CONNECTED = 1
var READY = 2
var LEVEL_LOADED = 3

// Incoming changes are batched up and aplied to the worldState at the beginning of each tick.
// These changes include player moves, connections and disconnections.
var pendingChanges = {
    players: {},
    ball: []
}

// game state
var WAITING_FOR_CONNECTIONS = 0
var WAITING_FOR_PLAYER_INIT = 1
var IN_PROGRESS = 2

// current state of the world
var worldState = {
    status: WAITING_FOR_CONNECTIONS,
    players: {},
    ball: {
        active: false
    },
    player1Score: 0,
    player2Score: 0
}

// Handle socket connection
io.on('connection', function(client) {
    // limit to 2 concurrent connections
    var numberOfClients = Object.keys(io.sockets.connected).length
    if (numberOfClients > 2) {
        io.to(client.id).emit('disconnect', {message: 'Too many users!'})
    }

    client.on('disconnect', function() {
        pendingChanges.players[client.id].state.push(DISCONNECTED)
        console.log("Disconnected client " + client.id)
        console.log((Object.keys(io.sockets.connected).length || "no") + " connections")
    })

    console.log("Connected client " + client.id)
    console.log((numberOfClients || "no") + " connections")

    worldState.players[client.id] = {
        state: CONNECTED
    }

    pendingChanges.players[client.id] = {
        moves: []
      , state: [CONNECTED]
    }

    client.on('playerReady', function() {
        pendingChanges.players[client.id].state.push(READY)
    })

    client.on('levelLoaded', function() {
        pendingChanges.players[client.id].state.push(LEVEL_LOADED)
    });

    client.on('clientMove', function(data) {
        // queue up the player moves
        pendingChanges.players[client.id].moves.push({
            dir: data.dir,
            ts: data.ts
        });
    });
});

function allPlayersHaveState(state) {
    return _.reduce(worldState.players, function(memo, playerState) {
        return memo && playerState.state === state
    }, true)
}

function allPlayersHaveAtLeastState(state) {
    return _.reduce(worldState.players, function(memo, playerState) {
        return memo && playerState.state >= state
    }, true)
}

function allPlayersAreReady() {
    return allPlayersHaveAtLeastState(READY) && _.size(worldState.players) === 2
}

function allPlayersLevelLoaded() {
    return allPlayersHaveState(LEVEL_LOADED) && _.size(worldState.players) === 2
}

function resetBall() {
    var state = {}
    state.x = _.random(0 + BALL_WIDTH/2 + 1, GAME_WIDTH - BALL_WIDTH/2 - 1);
    state.y = GAME_HEIGHT/2;

    // Randomize ball direction
    state.vx = Math.random() >= 0.5 ? -0.4 : 0.4
    state.vy = Math.random() >= 0.5 ? -0.4 : 0.4

    state.active = true;

    pendingChanges.ball.push(state)
}

// Run at 60 fps
setInterval(function() {
    processTick();
}, 1000.0 / 60);

function processTick() {
    // de-queue the pending player state changes (disconnections, etc)
    var clientIds = _.keys(pendingChanges.players)
    _.each(clientIds, function(clientId) {
        var stateChanges = pendingChanges.players[clientId].state

        while(stateChanges.length > 0) {
            var state = stateChanges.shift()

            // Disconnected
            if (state === DISCONNECTED) {
                // remove disconnected player
                delete worldState.players[clientId]
                delete pendingChanges.players[clientId]

                // Set remaining players to CONNECTED state
                var remainingPlayers = _.keys(worldState.players)
                _.each(remainingPlayers, function(player) {
                    worldState.players[player].state = CONNECTED
                })

                // Put game back to waiting state
                worldState.status = WAITING_FOR_CONNECTIONS

                // Reset scores
                worldState.player1Score = 0
                worldState.player2Score = 0

                return
            }

            // Player ready
            if (state === READY) {
                // do nothing
            }

            // Level loaded
            if (state === LEVEL_LOADED) {
                worldState.players[clientId].entity = new Entity(GAME_WIDTH/2, spawnPoints.get(), PADDLE_WIDTH, PADDLE_HEIGHT)
                worldState.ball.entity = new Entity(0, 0, BALL_WIDTH, BALL_HEIGHT)
            }

            worldState.players[clientId].state = state
        }
    })

    switch (worldState.status) {
        case WAITING_FOR_CONNECTIONS: {
            if (allPlayersAreReady()) {
                worldState.status = WAITING_FOR_PLAYER_INIT
            }
            break
        }
        case WAITING_FOR_PLAYER_INIT: {
            if (allPlayersLevelLoaded()) {
                worldState.status = IN_PROGRESS
                setTimeout(function() {
                    resetBall();
                }, 3000);
            }
            break
        }
    }

    var message = {}
    message.status = worldState.status

    // If the game is not IN_PROGRESS, we can send the message now and skip all the physics processing
    if (worldState.status != IN_PROGRESS) {
        io.emit('gameState', message)
        // console.log(JSON.stringify(worldState))
        return
    }

    // elapsed time
    var now = Date.now();
    var delta = now - prevTs;
    prevTs = now;

    // paddle moves
    message.players = {}
    _.each(worldState.players, function(playerState, clientId) {
        var entity = playerState.entity
        var oldx = entity.x
        var pendingMoves = pendingChanges.players[clientId].moves

        // de-queue all the accumulated player moves
        var ack
        while(pendingMoves.length > 0) {
            var move = pendingMoves.shift();
            var ack = move.ts
            // Speed is 600 pixels / second, or 0.6 pixels / millisecond
            entity.vx = move.dir * 0.6
            entity.update(delta)

            // Handle left/right wall collisions:
            if (entity.right > GAME_WIDTH) {
                entity.setX(GAME_WIDTH - entity.w/2)
            }

            if (entity.left < 0) {
                entity.setX(entity.w/2)
            }
        }

        // Only send an adjustment if the x coordinate has changed.
        // Use the ts of the last processed client message to notify
        // the client that it was the last message processed.
        // if (oldx !== entity.x) {
            message.clientAdjust = message.clientAdjust || []
            message.clientAdjust.push({
                id: clientId,
                ts: ack,
                x: entity.x
            })
        //}
        
        // Add player telemetry to outgoing message
        message.players[clientId] = {
            x: entity.x
          , y: entity.y
        }

    })


    // ball move
    var ball = worldState.ball.entity

    // Is there any pending setup for the ball?
    while(pendingChanges.ball.length > 0) {
        var pending = pendingChanges.ball.shift()
        ball.setX(pending.x)
        ball.setY(pending.y)
        ball.vx = pending.vx
        ball.vy = pending.vy
        worldState.ball.active = pending.active
    }

    message.ball = {}
    if (worldState.ball.active === true) {
        ball.update(delta)

        // Handle ball out of bounds in y direction.
        // Someone scored a point!  Register and reset ball.
        if (ball.top < 0 || ball.bottom > GAME_HEIGHT) {
            // the Phaser clients should handle killing the ball once it's out of bounds.
            worldState.ball.active = false

            var updateScore 

            if (ball.top < 0) {
                worldState.player2Score += 1
                updateScore = {
                    player: 'player2',
                    score: worldState.player2Score
                }
            }

            if (ball.bottom > GAME_HEIGHT) {
                worldState.player1Score += 1
                updateScore = {
                    player: 'player1',
                    score: worldState.player1Score
                }
            }

            message.updateScore = updateScore

            // reset ball
            setTimeout(function() {
                resetBall();
            }, 3000);
        }

        // Handle left/right wall collisions.
        if (ball.left <= 0) {
            ball.setX(ball.w/2)
            ball.vx = -ball.vx
        }

        if (ball.right >= GAME_WIDTH) {
            ball.setX(GAME_WIDTH - ball.w/2)
            ball.vx = -ball.vx
        }

        var player1 = worldState.players[_.keys(worldState.players)[0]].entity
        var player2 = worldState.players[_.keys(worldState.players)[1]].entity

        checkCollision(ball, player1)
        checkCollision(ball, player2)

        // Set ball telemetry to outgoing message
        message.ball.x = worldState.ball.entity.x
        message.ball.y = worldState.ball.entity.y
    }

    message.ball.active = worldState.ball.active

    if (!_.isEmpty(message)) {
        io.emit('gameState', message)
        // console.log(JSON.stringify(message))
    }
}
