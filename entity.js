Entity = function(x, y, w, h) {
    this.x = x
    this.y = y

    this.prev_x = x
    this.prev_y = y

    this.w = w
    this.h = h

    this.vx = 0
    this.vy = 0

    this.left = x - w/2
    this.right = x + w/2
    this.top = y - h/2
    this.bottom = y + h/2
}

Entity.prototype = {
    update: function(delta) {
        this.prev_x = this.x
        this.prev_y = this.y

        this.x = this.x + this.vx * delta
        this.y = this.y + this.vy * delta

        this.left = this.left + this.vx * delta
        this.right = this.right + this.vx * delta

        this.top = this.top + this.vy * delta
        this.bottom = this.bottom + this.vy * delta
    }
  , dx: function() {
      return this.x - this.prev_x
    }
  , dy: function() {
      return this.y - this.prev_y
    }
  , setX: function(x) {
      this.x = x
      this.left = x - this.w/2
      this.right = x + this.w/2
    }
  , setY: function(y) {
      this.y = y
      this.top = y - this.h/2
      this.bottom = y + this.h/2
    }
}

Entity.prototype.constructor = Entity;
