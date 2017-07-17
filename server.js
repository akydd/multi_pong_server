var app = require('express')()
  , server = require('http').Server(app)
  , io = require('socket.io')(server)
  , _ = require('underscore')
  , prevTs = 0;

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

// Simple rectangle with dimensions and velocity
var createGameObject = function(posx, posy, width, height) {
    var x = posx
    var y = posy

    var prev_x = x
    var prev_y = y

    var w = width
    var h = height

    var vx = 0
    var vy = 0

    var left = x - w/2
    var right = x + w/2
    var top = y - h/2
    var bottom = y + h/2

    return {
        update: function(delta) {
            prev_x = x
            prev_y = y
            x = x + vx * delta
            y = y + vy * delta
            this.updateBounds()
        }
      , updateBounds: function() {
            left = x - w/2
            right = x + w/2
            top = y - h/2
            bottom = y + h/2
        }
      , setVelocity: function(x, y) {
            vx = x
            vy = y
        }
      , getBounds: function() {
            return {
                left: left
              , right: right
              , top: top
              , bottom: bottom
            }
        }
      , dx: function() {
          return x - prev_x
        }
      , dy: function() {
          return y - prev_y
        }
    }
}

/*
 * Check for and handle collisions between a ball and a paddle
 */
var checkCollision = function(ball, paddle) {
    var b = ball.getBounds()
    var p = paddle.getBounds()

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
    var maxXoverlap = Math.abs(ball.dx()) + Math.abs(paddle.dx())
    var xOverlap = 0

    if (ball.dx() > paddle.dx()) {
        // ball is moving to the right, paddle is moving left or to the right, slower than the ball
        xOverlap = b.right - p.left
        if (xOverlap > maxXoverlap) {
            // overlap is too big to be a collision here.  Look elsewhere.
            xOverlap = 0
        }
    } else if (ball.dx() < paddle.dx()) {
        // ball is moving to the left, paddle is moving right or to the left, slower than the ball
        xOverlap = b.left - p.right
        if (-xOverlap > maxXoverlap) {
            // overlap is too big to be a collision here.  Look elsewhere.
            xOverlap = 0
        }
    }

    if (xOverlap !== 0) {
        // move the ball out of the xOverlap
        ball.x = ball.x - xOverlap
        // reverse x direction of the ball.  The paddle has infinite mass and is unaffected.
        ball.xv = -ball.xv
    }

    // Handle y axis.  Easier since paddle has no y axis movement
    var maxYoverlap = Math.abs(ball.dy())
    var yOverlap = 0

    if (ball.dy() < 0) {
        // ball is moving down
        yOverlap = b.bottom - p.top
        if (yOverlap > maxYoverlap) {
            // overlap is too big to be a collision here.  Look elsewhere.
            yOverlap = 0
        }
    } else if (ball.dy() < 0) {
        // ball is moving up
        yOverlap = b.top - p.bottom
        if (-yOverlap > maxYoverlap) {
            // overlap is too big to be a collision here.  Look elsewhere.
            yOverlap = 0
        }
    }

    if (yOverlap !== 0) {
        // move the ball out of the yOverlap
        ball.y = ball.y - yOverlap
        // reverse x direction of the ball.  The paddle has infinite mass and is unaffected.
        ball.yv = -ball.yv
    }
}

// Need to keep game object dimensions, locations, and velocity for physics
var PADDLE_WIDTH = 100
var PADDLE_HEIGHT = 20
var BALL_WIDTH = 20
var BALL_HEIGHT = 20
var GAME_WIDTH = 640
var GAME_HEIGHT = 640
var PLAYER_OFFSET_Y = 40    // absolute distance from the center of the paddle to the top/bottom of the game world
var PLAYER1_POS_Y = 0 + PLAYER_OFFSET_Y
var PLAYER2_POS_Y = GAME_HEIGHT - PLAYER_OFFSET_Y

// setup the player spawn positionss (y coordinate only)
var spawnPoints = createRingBuffer(2)
spawnPoints.push(40)
spawnPoints.push(600)


// Use the variables to denote player state
var DISCONNECTED = 0
var CONNECTED = 1
var READY = 2
var LEVEL_LOADED = 3

// Incoming changes are batched up and aplied to the worldState at the beginning of each tick.
// These changes include player moves, connections and disconnections.
var pendingChanges = {
    playersState: {},
    ballState: []
}

// game state
var WAITING_FOR_CONNECTIONS = 0
var WAITING_FOR_PLAYER_INIT = 1
var IN_PROGRESS = 2

// current state of the world
var worldState = {
    status: WAITING_FOR_CONNECTIONS,
    playersState: {},
    ballState: {
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
        pendingChanges.playersState[client.id].state.push(DISCONNECTED)
    })

    console.log("Connected client " + client.id)
    console.log((numberOfClients || "no") + " connections");

    worldState.playersState[client.id] = {
        state: CONNECTED
    }

    pendingChanges.playersState[client.id] = {
        moves: []
      , state: [CONNECTED]
    }

    client.on('playerReady', function() {
        pendingChanges.playersState[client.id].state.push(READY)
    })

    client.on('levelLoaded', function() {
        pendingChanges.playersState[client.id].state.push(LEVEL_LOADED)
    });

    client.on('clientMove', function(data) {
        // queue up the player moves
        pendingChanges.playersState[client.id].moves.push({
            dir: data.dir,
            ts: data.ts
        });
    });
});

function allPlayersHaveState(state) {
    return _.reduce(worldState.playersState, function(memo, playerState) {
        return memo && playerState.state === state
    }, true)
}

function allPlayersHaveAtLeastState(state) {
    return _.reduce(worldState.playersState, function(memo, playerState) {
        return memo && playerState.state >= state
    }, true)
}

function allPlayersAreReady() {
    return allPlayersHaveAtLeastState(READY) && _.size(worldState.playersState) === 2
}

function allPlayersLevelLoaded() {
    return allPlayersHaveState(LEVEL_LOADED) && _.size(worldState.playersState) === 2
}

function resetBall() {
    var state = {}
    state.posx = _.random(0 + BALL_WIDTH/2 + 1, GAME_WIDTH - BALL_WIDTH/2 - 1);
    state.posy = GAME_HEIGHT/2;

    var directions = [-1, 1];

    var xdirIndex = _.random(0, 1);
    state.xdir = directions[xdirIndex];

    var ydirIndex = _.random(0, 1);
    state.ydir = directions[ydirIndex];

    state.active = true;

    pendingChanges.ballState.push(state)
}

setInterval(function() {
    processTick();
}, 1000.0 / 60);

function processTick() {
    // de-queue the pending player state changes (disconnections, etc)
    var clientIds = _.keys(pendingChanges.playersState)
    _.each(clientIds, function(clientId) {
        var stateChanges = pendingChanges.playersState[clientId].state

        while(stateChanges.length > 0) {
            var state = stateChanges.shift()

            // Disconnected
            if (state === DISCONNECTED) {
                delete worldState.playersState[clientId]
                delete pendingChanges.playersState[clientId]
                worldState.status = WAITING_FOR_CONNECTIONS
                return
            }

            // Player ready
            if (state === READY) {
                // do nothing
            }

            // Level loaded
            if (state === LEVEL_LOADED) {
                worldState.playersState[clientId].posx = GAME_WIDTH/2
                worldState.playersState[clientId].posy = spawnPoints.get()
            }

            worldState.playersState[clientId].state = state
        }
    })

    // TODO: handle case where player is disconnected
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

    message.playersState = worldState.playersState

    // elapsed time
    var now = Date.now();
    var delta = now - prevTs;
    prevTs = now;

    // paddle moves
    _.each(worldState.playersState, function(playerState, clientId) {
        var oldposx = playerState.posx;
        var pendingMoves = pendingChanges.playersState[clientId].moves

        // de-queue all the accumulated player moves
        while(pendingMoves.length > 0) {
            var move = pendingMoves.shift();
            playerState.posx = Math.round(playerState.posx + move.dir * 0.6 * delta);

            // Handle left/right wall collisions:
            // The paddles are 100px wide, anchored at 50px, and the game world is 640px wide.
            // This means that a paddle's xpos cannot be < 50 or > 590.
            if (playerState.posx > GAME_WIDTH - PADDLE_WIDTH/2) {
                playerState.posx = GAME_WIDTH - PADDLE_WIDTH/2;
            }

            if (playerState.posx < 0 + PADDLE_WIDTH/2) {
                playerState.posx = 0 + PADDLE_WIDTH/2;
            }
        }

        // Only send an adjustment if the posx has changed
        if (oldposx !== playerState.posx) {
            message.clientAdjust = message.clientAdjust || []
            message.clientAdjust.push({
                id: clientId,
                ts: Date.now(),
                posx: playerState.posx
            })
        }
    })

    // ball move
    var ballState = {}

    // Is there any pending setup for the ball?
    while(pendingChanges.ballState.length > 0) {
        worldState.ballState = pendingChanges.ballState.shift()
    }

    if (worldState.ballState.active === true) {
        // calculate new position of ball, given that x/y speeds are each 400px/s
        worldState.ballState.posx = worldState.ballState.posx + worldState.ballState.xdir * 0.4 * delta;
        worldState.ballState.posy = worldState.ballState.posy + worldState.ballState.ydir * 0.4 * delta;

        // Handle ball out of bounds in y direction.
        // Someone scored a point!  Register and reset ball.
        if (worldState.ballState.posy < 0 - BALL_HEIGHT/2 || worldState.ballState.posy > GAME_HEIGHT + BALL_HEIGHT/2) {
            // the Phaser clients should handle killing the ball once it's out of bounds.
            worldState.ballState.active = false

            var updateScore 

            if (worldState.ballState.posy < 0 - BALL_HEIGHT/2) {
                worldState.player2Score += 1
                updateScore = {
                    player: 'player2',
                    score: worldState.player2Score
                }
            }

            if (worldState.ballState.posy > GAME_HEIGHT + BALL_HEIGHT/2) {
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
        // The ball is is a 20x20 square, so it will hit a wall when xpos = 10
        // or when xpos = 630.  In either case, switch x direction.
        if (worldState.ballState.posx <= 0 + BALL_WIDTH/2) {
            worldState.ballState.posx = 0 + BALL_WIDTH/2;
            worldState.ballState.xdir = 1
        }

        if (worldState.ballState.posx >= GAME_WIDTH - BALL_WIDTH/2) {
            worldState.ballState.posx = GAME_WIDTH - BALL_WIDTH/2;
            worldState.ballState.xdir = -1
        }

        // Handle ball & paddle collisions.
        // Note that the max x overlap that can occur is exactly delta, since the paddle moves at 0.6x/delta and the ball moves at 0.4x/delta and 0.4y/delta.
        // The max y overlap that can occur is 0.4 * delta.

        var player1 = worldState.playersState[_.keys(worldState.playersState)[0]]
        var player2 = worldState.playersState[_.keys(worldState.playersState)[1]]

        // Collision of ball to front of top paddle
        if (worldState.ballState.posy <= 0 + PLAYER1_POS_Y + PADDLE_HEIGHT/2  && worldState.ballState.posy >= 50 - 0.4 * delta && worldState.ballState.posx >= player1.posx - 50 - 10 && worldState.ballState.posx <= player1.posx + 50 + 10) {
            // push the ball up to the surface of the paddle
            worldState.ballState.posy = 50
            worldState.ballState.ydir = 1
        }

        // Collision of ball to left side of top paddle
        if (worldState.ballState.posy <= 50 && worldState.ballState.posy >= 10 && worldState.ballState.posx >= player1.posx - 50 - 10 && worldState.ballState.posx <= player1.posx - 50 - 10 + delta) {
            // push the ball to the left surface of the paddle
            worldState.ballState.posx = player1.posx - 50 - 10
            worldState.ballState.xdir = -1
        }

        // Collision of ball to right side of top paddle
        if (worldState.ballState.posy <= 50 && worldState.ballState.posy >= 10 && worldState.ballState.posx <= player1.posx + 50 + 10 && worldState.ballState.posx >= player1.posx + 50 + 10 - delta) {
            // push the ball to the left surface of the paddle
            worldState.ballState.posx = player1.posx + 50 + 10
            worldState.ballState.xdir = 1
        }

        // Collision of ball to front of bottom paddle
        if (worldState.ballState.posy >= 590  && worldState.ballState.posy <= 590 + 0.4 * delta && worldState.ballState.posx >= player2.posx - 50 - 10 && worldState.ballState.posx <= player2.posx + 50 + 10) {
            // push the ball up to the surface of the paddle
            worldState.ballState.posy = 590
            worldState.ballState.ydir = -1
        }

        // Collision of ball to left side of bottom paddle
        if (worldState.ballState.posy <= 630 && worldState.ballState.posy >= 590 && worldState.ballState.posx >= player2.posx - 50 - 10 && worldState.ballState.posx <= player2.posx - 50 - 10 + delta) {
            // push the ball to the left surface of the paddle
            worldState.ballState.posx = player2.posx - 50 - 10
            worldState.ballState.xdir = -1
        }

        // Collision of ball to right side of bottom paddle
        if (worldState.ballState.posy <= 630 && worldState.ballState.posy >= 590 && worldState.ballState.posx <= player2.posx + 50 + 10 && worldState.ballState.posx >= player2.posx + 50 + 10 - delta) {
            // push the ball to the left surface of the paddle
            worldState.ballState.posx = player2.posx + 50 + 10
            worldState.ballState.xdir = 1
        }

        ballState.posx = worldState.ballState.posx
        ballState.posy = worldState.ballState.posy
    }

    ballState.active = worldState.ballState.active
    message.ballState = ballState

    if (!_.isEmpty(message)) {
        io.emit('gameState', message)
        // console.log(JSON.stringify(worldState))
    }
}
