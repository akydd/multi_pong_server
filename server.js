var app = require('express')()
  , server = require('http').Server(app)
  , io = require('socket.io')(server)
  , _ = require('underscore')
  , prevTs = 0;

var port = process.env.PORT || 8000
server.listen(port);
console.log("Listening on port " + port)

var worldState = {
    status: 'waiting',
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

    // TODO: handle case if one player leaves mid game.
    client.on('disconnect', function() {
        console.log("Disconnected client: " + client.id)
    })

    console.log("Connected client " + client.id)
    console.log((numberOfClients || "no") + " connections");

    worldState.playersState[client.id] = {
        state: 'connected',
        posx: 320,
        moves: []
    }

    client.on('playerReady', function() {
        worldState.playersState[client.id].state = 'ready'

        if (allPlayersAreReady()) {
            worldState.status = 'startgame'
        }
    });

    client.on('levelLoaded', function() {
        worldState.playersState[client.id].state = 'levelLoaded'

        if (allPlayersLevelLoaded()) {
            io.emit('spawnPlayers', [
                {
                    id: _.keys(worldState.playersState)[0],
                    pos: {
                        x: 320,
                        y: 40
                    }
                },
                {
                    id: _.keys(worldState.playersState)[1],
                    pos: {
                        x: 320,
                        y: 600
                    }
                }
            ]);

            setTimeout(function() {
                resetBall();
            }, 3000);
        }
    });

    client.on('clientMove', function(data) {
        worldState.playersState[client.id].moves.push({
            dir: data.dir,
            ts: data.ts
        });
    });

    // TODO: set the client to waiting state if connected clients < 2
    client.on('disconnect', function() {
        delete worldState.playersState[client.id]
        worldState.status = 'waiting'
        console.log((Object.keys(io.sockets.connected).length || "no") + " connections");
    });

});

function allPlayersHaveState(state) {
    return _.reduce(worldState.playersState, function(memo, playerState) {
        return memo && playerState.state === state
    }, true)
}

function allPlayersAreReady() {
    return allPlayersHaveState('ready') && _.size(worldState.playersState) === 2
}

function allPlayersLevelLoaded() {
    return allPlayersHaveState('levelLoaded') && _.size(worldState.playersState) === 2
}

function resetBall() {
    worldState.ballState.posx = _.random(11, 629);
    worldState.ballState.posy = 320;

    var directions = [-1, 1];

    var xdirIndex = _.random(0, 1);
    worldState.ballState.xdir = directions[xdirIndex];

    var ydirIndex = _.random(0, 1);
    worldState.ballState.ydir = directions[ydirIndex];

    worldState.ballState.active = true;
}

setInterval(function() {
    processMoves();
}, 1000.0 / 60);

function processMoves() {
    // elapsed time
    var now = Date.now();
    var delta = now - prevTs;
    prevTs = now;

    var message = {}

    // paddle moves
    _.each(worldState.playersState, function(playerState, clientId) {
        var oldposx = playerState.posx;

        while(playerState.moves.length > 0) {
            var move = playerState.moves.shift();
            playerState.posx = Math.round(playerState.posx + move.dir * 0.6 * delta);

            // Handle left/right wall collisions:
            // The paddles are 100px wide, anchored at 50px, and the game world is 640px wide.
            // This means that a paddle's xpos cannot be < 50 or > 590.
            if (playerState.posx > 590) {
                playerState.posx = 590;
            }

            if (playerState.posx < 50) {
                playerState.posx = 50;
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
    });

    // ball move
    var ballState = {}
    if (worldState.ballState.active === true) {
        // calculate new position of ball, given that x/y speeds are each 400px/s
        worldState.ballState.posx = worldState.ballState.posx + worldState.ballState.xdir * 0.4 * delta;
        worldState.ballState.posy = worldState.ballState.posy + worldState.ballState.ydir * 0.4 * delta;

        // Handle ball out of bounds in y direction.
        // Someone scored a point!  Register and reset ball.
        if (worldState.ballState.posy < -10 || worldState.ballState.posy > 650) {
            // the Phaser clients should handle killing the ball once it's out of bounds.
            worldState.ballState.active = false

            var updateScore 

            if (worldState.ballState.posy <= 0) {
                worldState.player2Score += 1
                updateScore = {
                    player: 'player2',
                    score: worldState.player2Score
                }
            }

            if (worldState.ballState.posy >= 640) {
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
        if (worldState.ballState.posx <= 10) {
            worldState.ballState.posx = 10;
            worldState.ballState.xdir = 1
        }

        if (worldState.ballState.posx >= 630) {
            worldState.ballState.posx = 630;
            worldState.ballState.xdir = -1
        }

        // Handle ball & paddle collisions.
        // Note that the max x overlap that can occur is exactly delta, since the paddle moves at 0.6x/delta and the ball moves at 0.4x/delta and 0.4y/delta.
        // The max y overlap that can occur is 0.4 * delta.

        var player1 = worldState.playersState[_.keys(worldState.playersState)[0]]
        var player2 = worldState.playersState[_.keys(worldState.playersState)[1]]

        // Collision of ball to front of top paddle
        if (worldState.ballState.posy <= 50  && worldState.ballState.posy >= 50 - 0.4 * delta && worldState.ballState.posx >= player1.posx - 50 - 10 && worldState.ballState.posx <= player1.posx + 50 + 10) {
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
    message.status = worldState.status

    if (!_.isEmpty(message)) {
        io.emit('gameState', message)
        console.log(JSON.stringify(message))
    }
}
