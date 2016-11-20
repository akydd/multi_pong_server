var app = require('express')()
  , server = require('http').Server(app)
  , io = require('socket.io')(server)
  , _ = require('underscore')
  , prevTs = 0;

server.listen(8000);

var playersState = {};

var ballState = {
    active: false
};

var player1Score = 0;
var player2Score = 0;

// Handle socket connection
io.on('connection', function(client) {
    // TODO: limit to 2 concurrent connections
    console.log((Object.keys(io.sockets.connected).length || "no") + " connections");

    playersState[client.id] = {
        state: 'connected',
        posx: 320,
        moves: []
    }

    client.on('playerReady', function() {
        playersState[client.id].state = 'ready'

        if (allPlayersAreReady()) {
            io.emit('startgame');
        }
    });

    client.on('levelLoaded', function() {
        playersState[client.id].state = 'levelLoaded'
        client.emit('setId', {id: client.id});

        if (allPlayersLevelLoaded()) {
            io.emit('spawnPlayers', [
                {
                    id: _.keys(playersState)[0],
                    pos: {
                        x: 320,
                        y: 40
                    }
                },
                {
                    id: _.keys(playersState)[1],
                    pos: {
                        x: 320,
                        y: 920
                    }
                }
            ]);

            setTimeout(function() {
                resetBall();
            }, 3000);
        }
    });

    client.on('clientMove', function(data) {
        playersState[client.id].moves.push({
            dir: data.dir,
            ts: data.ts
        });
    });

    client.on('disconnect', function() {
        delete playersState[client.id]
        console.log((Object.keys(io.sockets.connected).length || "no") + " connections");
    });

});

function allPlayersHaveState(state) {
    return _.reduce(playersState, function(memo, playerState) {
        return memo && playerState.state === state
    }, true)
}

function allPlayersAreReady() {
    return allPlayersHaveState('ready') && _.size(playersState) === 2
}

function allPlayersLevelLoaded() {
    return allPlayersHaveState('levelLoaded') && _.size(playersState) === 2
}

function resetBall() {
    ballState.posx = _.random(11, 629);
    ballState.posy = 480;

    var directions = [-1, 1];

    var xdirIndex = _.random(0, 1);
    ballState.xdir = directions[xdirIndex];

    var ydirIndex = _.random(0, 1);
    ballState.ydir = directions[ydirIndex];

    ballState.active = true;

    io.emit('resetBall', ballState);
}

setInterval(function() {
    processMoves();
}, 1000.0 / 60);

function processMoves() {
    // elapsed time
    var now = Date.now();
    var delta = now - prevTs;
    prevTs = now;

    // paddle moves
    _.each(playersState, function(playerState, clientId) {
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

        // TODO: optimize so that clientadjust messages are only sent when necessary
        if (oldposx !== playerState.posx) {
            io.emit('clientadjust', {
                id: clientId,
                ts: Date.now(),
                posx: playerState.posx
            });
            // console.log(playerState.posx);
        }
    });

    // ball move
    if (ballState.active === true) {
        // calculate new position of ball, given that x/y speeds are each 400px/s
        ballState.posx = ballState.posx + ballState.xdir * 0.4 * delta;
        ballState.posy = ballState.posy + ballState.ydir * 0.4 * delta;

        // Handle ball out of bounds in y direction.
        // Someone scored a point!  Register and reset ball.
        if (ballState.posy <= 0 || ballState.posy >= 960) {
            ballState.active = false;

            if (ballState.posy <= 0) {
                player2Score += 1
                io.emit('updateScore', {
                    player: 'player2',
                    score: player2Score
                })
            }

            if (ballState.posy >= 960) {
                player1Score += 1
                io.emit('updateScore', {
                    player: 'player1',
                    score: player1Score
                })
            }

            // reset ball
            setTimeout(function() {
                resetBall();
            }, 3000);
        }

        // Handle left/right wall collisions.
        // The ball is is a 20x20 square, so it will hit a wall when xpos = 10
        // or when xpos = 630.  In either case, switch x direction.
        if (ballState.posx <= 10) {
            ballState.posx = 10;
            ballState.xdir = ballState.xdir * -1;
        }

        if (ballState.posx >= 630) {
            ballState.posx = 630;
            ballState.xdir = ballState.xdir * -1;
        }



        // Handle ball & paddle collisions.
        // The ball is a 20x20 square, so it will collide with:
        // - player1 when its y coordinate is <= 50
        // - player2 when its y coordinate is >= 910
        // In either case we do a simple


        console.log('ballpos - x: ' + ballState.posx + ', y: ' + ballState.posy);
        io.emit('updateBallState', {
            posx: ballState.posx,
            posy: ballState.posy
        });
    }
}
