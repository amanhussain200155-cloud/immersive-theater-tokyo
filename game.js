/* =========================================================================
   Operation: Nightingale — a browser-based spy platformer
   Single-file engine: game loop, physics, player, enemies, levels,
   riddle gates, boss fight, and win screen.
   ========================================================================= */

(() => {
  "use strict";

  // ---------------------------------------------------------------------
  // Canvas / constants
  // ---------------------------------------------------------------------
  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");
  const W = canvas.width;   // 960
  const H = canvas.height;  // 540

  // Scale the canvas to fit the viewport while preserving its 16:9 aspect
  // ratio (letterbox). This guarantees the whole scene is visible on any
  // screen — no cropping on the right, characters stay visible.
  function fitCanvas() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const scale = Math.min(vw / W, vh / H);
    const cssW = Math.round(W * scale);
    const cssH = Math.round(H * scale);
    canvas.style.width = cssW + "px";
    canvas.style.height = cssH + "px";
  }
  window.addEventListener("resize", fitCanvas);
  window.addEventListener("orientationchange", () => setTimeout(fitCanvas, 200));
  fitCanvas();

  // Best-effort fullscreen + landscape lock (only where the browser allows).
  function enterFullscreenLandscape() {
    const el = document.documentElement;
    const req = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen;
    if (req) {
      try {
        const p = req.call(el);
        const lock = () => {
          if (screen.orientation && screen.orientation.lock) {
            screen.orientation.lock("landscape").catch(() => {});
          }
        };
        if (p && p.then) p.then(lock).catch(() => {}); else lock();
      } catch (e) { /* unsupported — ignore */ }
    }
    setTimeout(fitCanvas, 300);
  }

  const GRAVITY = 0.6;
  const MAX_FALL = 14;
  const MOVE_SPEED = 4.2;
  const JUMP_VELOCITY = -13.6;
  const CLIMB_SPEED = 3;
  const FRICTION = 0.8;
  const COYOTE_FRAMES = 7;   // grace period to still jump just after leaving a ledge
  const JUMP_BUFFER = 7;     // remember a jump press slightly before landing

  // ---------------------------------------------------------------------
  // Input
  // ---------------------------------------------------------------------
  const keys = {};
  const pressed = {}; // one-shot presses (consumed on read)

  // Aim vector set by dragging an action button (shoot/bomb/web). While a
  // drag is active, this overrides keyboard aim. Range ~[-1,1] per axis.
  const touchAim = { x: 0, y: 0, active: false };

  window.addEventListener("keydown", (e) => {
    // prevent page scroll on arrows/space while playing
    if (["ArrowUp","ArrowDown","ArrowLeft","ArrowRight"," "].includes(e.key)) {
      if (state.mode === "play") e.preventDefault();
    }
    const k = normKey(e.key);
    if (!keys[k]) pressed[k] = true;
    keys[k] = true;
  });
  window.addEventListener("keyup", (e) => { keys[normKey(e.key)] = false; });

  // ---- On-screen touch controls ----------------------------------------
  // Each button maps to the same key state the keyboard uses, so the rest
  // of the game logic needs no changes.
  const touchControls = document.getElementById("touch-controls");

  function setTouchKey(action, down) {
    switch (action) {
      case "left":  keys["a"] = down; break;
      case "right": keys["d"] = down; break;
      case "shoot": keys["j"] = down; break;
      case "web":
        keys["l"] = down;
        if (down) pressed["l"] = true; // fire the one-shot web throw
        break;
      case "bomb":
        keys["k"] = down;
        if (down) pressed["k"] = true; // fire the one-shot bomb throw
        break;
      case "jump":
        keys["space"] = down;
        if (down) pressed["space"] = true; // fire the buffered one-shot jump
        break;
    }
  }

  function bindTouchButton(btn) {
    const action = btn.getAttribute("data-key");
    const press = (e) => {
      e.preventDefault();
      btn.classList.add("pressed");
      setTouchKey(action, true);
    };
    const release = (e) => {
      if (e) e.preventDefault();
      btn.classList.remove("pressed");
      setTouchKey(action, false);
    };
    // Touch
    btn.addEventListener("touchstart", press, { passive: false });
    btn.addEventListener("touchend", release, { passive: false });
    btn.addEventListener("touchcancel", release, { passive: false });
    // Mouse (so it also works when testing on desktop)
    btn.addEventListener("mousedown", press);
    btn.addEventListener("mouseup", release);
    btn.addEventListener("mouseleave", release);
  }

  if (touchControls) {
    touchControls.querySelectorAll(".tbtn").forEach((btn) => {
      if (btn.classList.contains("aimbtn")) bindAimButton(btn); // shoot/bomb/web drag-to-aim
      else bindTouchButton(btn);                                 // left/right/jump
    });
    function revealTouch() {
      touchControls.classList.remove("hidden");
    }
    // Reveal on any touch/pointer interaction.
    window.addEventListener("touchstart", revealTouch, { passive: true });
    window.addEventListener("pointerdown", revealTouch, { passive: true });
    // Reveal immediately on touch-capable / coarse-pointer devices.
    const isTouch = ("ontouchstart" in window) ||
        (navigator.maxTouchPoints && navigator.maxTouchPoints > 0) ||
        (window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
    if (isTouch) revealTouch();
  }

  // ---- Drag-to-aim action buttons (shoot / bomb / web) ----
  // Press an action button and (optionally) drag to aim; releasing fires the
  // action in the aimed direction. A quick tap fires straight ahead.
  let aimHold = 0; // frames to keep touchAim active around a release
  function aimFromDrag(btn, clientX, clientY) {
    const r = btn.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const dx = clientX - cx, dy = clientY - cy;
    const dist = Math.hypot(dx, dy);
    if (dist < 12) {           // basically a tap — aim straight ahead
      touchAim.x = player.facing; touchAim.y = 0;
    } else {
      touchAim.x = dx / dist; touchAim.y = dy / dist;
    }
    touchAim.active = true;
  }
  let shootPulse = 0; // frames to hold the shoot key after a tap/drag-release
  function fireAction(action) {
    // Hold the aim briefly so the shot/throw uses the aimed direction.
    aimHold = 6;
    if (action === "shoot") { shootPulse = 4; }         // frame-based shoot hold
    else if (action === "bomb") { pressed["k"] = true; } // one-shot consumed by BOMB()
    else if (action === "web")  { pressed["l"] = true; } // one-shot consumed by WEB()
  }
  function bindAimButton(btn) {
    const action = btn.getAttribute("data-key");
    let ptr = null;
    const down = (e) => {
      e.preventDefault();
      ptr = (e.pointerId != null) ? e.pointerId : "touch";
      if (btn.setPointerCapture && e.pointerId != null) { try { btn.setPointerCapture(e.pointerId); } catch (_) {} }
      btn.classList.add("pressed");
      const p = e.touches ? e.touches[0] : e;
      aimFromDrag(btn, p.clientX, p.clientY);
    };
    const move = (e) => {
      if (ptr === null) return;
      e.preventDefault();
      const p = e.touches ? e.touches[0] : e;
      aimFromDrag(btn, p.clientX, p.clientY);
    };
    const up = (e) => {
      if (ptr === null) return;
      e.preventDefault();
      btn.classList.remove("pressed");
      fireAction(action);           // fire in the current aim direction
      ptr = null;
      // clear aim shortly after so it doesn't linger
      setTimeout(() => { if (aimHold <= 0) { touchAim.active = false; touchAim.x = 0; touchAim.y = 0; } }, 90);
    };
    btn.addEventListener("pointerdown", down);
    btn.addEventListener("pointermove", move);
    btn.addEventListener("pointerup", up);
    btn.addEventListener("pointercancel", up);
    // touch fallback
    btn.addEventListener("touchstart", down, { passive: false });
    btn.addEventListener("touchmove", move, { passive: false });
    btn.addEventListener("touchend", up, { passive: false });
  }

  // ---- Mute toggle (button + 'M' key) ----
  const muteBtn = document.getElementById("mute-btn");
  function doToggleMute() {
    const nowMuted = Sfx.toggleMute();
    if (muteBtn) muteBtn.textContent = nowMuted ? "🔇" : "🔊";
  }
  if (muteBtn) {
    muteBtn.addEventListener("click", (e) => { e.preventDefault(); Sfx.unlock(); doToggleMute(); });
  }
  window.addEventListener("keydown", (e) => { if (normKey(e.key) === "m") doToggleMute(); });

  const fsBtn = document.getElementById("fs-btn");
  if (fsBtn) {
    fsBtn.addEventListener("click", (e) => { e.preventDefault(); enterFullscreenLandscape(); });
  }

  function normKey(k) {
    if (k === " ") return "space";
    return k.length === 1 ? k.toLowerCase() : k;
  }
  function consume(k) { if (pressed[k]) { pressed[k] = false; return true; } return false; }

  // ---------------------------------------------------------------------
  // Audio — synthesized with the Web Audio API (no external files, works
  // offline). Must be resumed on a user gesture (browsers block autoplay),
  // so Sfx.unlock() is called from the Start button.
  // ---------------------------------------------------------------------
  const Sfx = (() => {
    const AC = window.AudioContext || window.webkitAudioContext;
    let ctxA = null;
    let master = null;
    let musicGain = null;
    let musicTimer = null;
    let muted = false;
    let step = 0;

    function ensure() {
      if (!AC) return false;
      if (!ctxA) {
        ctxA = new AC();
        master = ctxA.createGain();
        master.gain.value = 0.6;
        master.connect(ctxA.destination);
        musicGain = ctxA.createGain();
        musicGain.gain.value = 0.18;
        musicGain.connect(master);
      }
      return true;
    }

    // One-shot beep/blip.
    function tone(freq, dur, type = "square", gain = 0.25, slideTo = null) {
      if (muted || !ensure()) return;
      const t = ctxA.currentTime;
      const osc = ctxA.createOscillator();
      const g = ctxA.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t);
      if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
      g.gain.setValueAtTime(gain, t);
      g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
      osc.connect(g); g.connect(master);
      osc.start(t); osc.stop(t + dur + 0.02);
    }

    // Short noise burst (for hits / hurt).
    function noise(dur, gain = 0.3, hp = 800) {
      if (muted || !ensure()) return;
      const t = ctxA.currentTime;
      const n = Math.floor(ctxA.sampleRate * dur);
      const buf = ctxA.createBuffer(1, n, ctxA.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
      const src = ctxA.createBufferSource(); src.buffer = buf;
      const filt = ctxA.createBiquadFilter(); filt.type = "highpass"; filt.frequency.value = hp;
      const g = ctxA.createGain(); g.gain.value = gain;
      src.connect(filt); filt.connect(g); g.connect(master);
      src.start(t);
    }

    // A moody spy-lounge loop: 4-chord progression (Am–F–C–G) with a
    // walking bass, a soft arpeggio, and occasional melody notes.
    // Note frequencies:
    const N = {
      A2:110.00, C3:130.81, E3:164.81, F2:87.31, G2:98.00,
      A3:220.00, C4:261.63, E4:329.63, F3:174.61, G3:196.00,
      A4:440.00, C5:523.25, E5:659.25, F4:349.23, G4:392.00,
    };
    // Each chord: [bass, [arpeggio notes...]]
    const PROG = [
      [N.A2, [N.A3, N.C4, N.E4, N.C4]],  // Am
      [N.F2, [N.F3, N.A3, N.C4, N.A3]],  // F
      [N.C3, [N.C4, N.E4, N.G4, N.E4]],  // C
      [N.G2, [N.G3, N.C4, N.E4, N.C4]],  // G
    ];
    const MELODY = [N.E5, 0, N.C5, N.A4, 0, N.G4, N.A4, 0,
                    N.C5, 0, N.E5, N.G4, 0, N.E4, 0, 0];
    function musicStep() {
      if (muted || !ensure()) return;
      const chord = PROG[Math.floor(step / 4) % PROG.length];
      const beat = step % 4;
      // bass on every beat (with a soft octave lift mid-bar)
      tone(chord[0] * (beat === 2 ? 2 : 1), 0.42, "triangle", 0.14);
      // arpeggio note each beat
      tone(chord[1][beat], 0.28, "sine", 0.10);
      // melody every other beat
      const mel = MELODY[step % MELODY.length];
      if (mel) tone(mel, 0.34, "triangle", 0.09);
      // soft brush on the off-beats
      if (beat === 1 || beat === 3) noise(0.04, 0.03, 5000);
      step++;
    }

    return {
      unlock() {
        if (!ensure()) return;
        if (ctxA.state === "suspended") ctxA.resume();
      },
      shoot()     { tone(880, 0.09, "square", 0.16, 220); },
      jump()      { tone(360, 0.16, "square", 0.18, 720); },
      hit()       { noise(0.09, 0.28, 1200); tone(200, 0.08, "sawtooth", 0.12, 90); },
      enemyDown() { noise(0.22, 0.32, 500); tone(160, 0.3, "sawtooth", 0.18, 60); },
      hurt()      { noise(0.18, 0.3, 300); tone(140, 0.22, "square", 0.16, 70); },
      bossHit()   { tone(120, 0.1, "sawtooth", 0.12, 80); },
      win()       { [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => tone(f, 0.28, "sine", 0.25), i * 140)); },
      lose()      { [440, 349, 262].forEach((f, i) => setTimeout(() => tone(f, 0.35, "triangle", 0.22), i * 180)); },
      // The "Happy Birthday to You" melody. [freq, beats] pairs; 0 = rest.
      happyBirthday() {
        if (!ensure()) return;
        const G4=392.00, A4=440.00, B4=493.88, C5=523.25, D5=587.33,
              E5=659.25, F5=698.46, G5=783.99;
        const beat = 340; // ms per beat
        const notes = [
          // Hap-py birth-day to you
          [G4,0.75],[G4,0.25],[A4,1],[G4,1],[C5,1],[B4,2],
          // Hap-py birth-day to you
          [G4,0.75],[G4,0.25],[A4,1],[G4,1],[D5,1],[C5,2],
          // Hap-py birth-day dear Risa-san
          [G4,0.75],[G4,0.25],[G5,1],[E5,1],[C5,1],[B4,1],[A4,2],
          // Hap-py birth-day to you
          [F5,0.75],[F5,0.25],[E5,1],[C5,1],[D5,1],[C5,2],
        ];
        let t = 0;
        for (const [f, b] of notes) {
          const dur = b * beat;
          if (f > 0) {
            const at = t;
            setTimeout(() => tone(f, (dur / 1000) * 0.9, "triangle", 0.28), at);
          }
          t += dur;
        }
      },
      startMusic() {
        if (!ensure() || musicTimer) return;
        step = 0;
        musicTimer = setInterval(musicStep, 260);
      },
      stopMusic() { if (musicTimer) { clearInterval(musicTimer); musicTimer = null; } },
      toggleMute() {
        muted = !muted;
        if (muted) this.stopMusic();
        else this.startMusic();
        return muted;
      },
      isMuted() { return muted; },
    };
  })();

  // ---------------------------------------------------------------------
  // Clue photos — optional real images loaded from ./images/<id>.<ext>.
  // If a file exists and loads, the torn-photo mechanic uses the real photo;
  // otherwise it falls back to a drawn placeholder (drawClueImage).
  // To add a real photo: drop e.g. images/lantern.jpg (or .png) next to
  // index.html. Filenames must match the level's clueImage id.
  // ---------------------------------------------------------------------
  const ClueImages = (() => {
    const cache = {};   // id -> { img, ready:false, failed:false }
    const EXTS = ["jpg", "png", "jpeg", "webp"];

    function load(id) {
      if (cache[id]) return cache[id];
      const entry = { img: null, ready: false, failed: false };
      cache[id] = entry;
      // Try each extension in turn; first that loads wins.
      let i = 0;
      const tryNext = () => {
        if (i >= EXTS.length) { entry.failed = true; return; }
        const im = new Image();
        im.onload = () => { entry.img = im; entry.ready = true; };
        im.onerror = () => { i++; tryNext(); };
        im.src = "images/" + id + "." + EXTS[i];
      };
      // Image may be unavailable in non-browser contexts; guard it.
      if (typeof Image !== "undefined") tryNext(); else entry.failed = true;
      return entry;
    }

    return {
      preload(ids) { ids.forEach(load); },
      // Returns a ready HTMLImageElement or null (use placeholder).
      get(id) {
        const e = cache[id] || load(id);
        return (e && e.ready) ? e.img : null;
      },
    };
  })();

  const LEFT  = () => keys["a"] || keys["ArrowLeft"];
  const RIGHT = () => keys["d"] || keys["ArrowRight"];
  const UP    = () => keys["w"] || keys["ArrowUp"];
  const DOWN  = () => keys["s"] || keys["ArrowDown"];
  const JUMP  = () => consume("space");
  const SHOOT = () => keys["j"] || keys["f"] || shootPulse > 0;
  const BOMB  = () => consume("k") || consume("b");
  const WEB   = () => consume("l") || consume("g");

  // ---------------------------------------------------------------------
  // Geometry helpers
  // ---------------------------------------------------------------------
  function rectsOverlap(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x &&
           a.y < b.y + b.h && a.y + a.h > b.y;
  }

  // ---------------------------------------------------------------------
  // Global game state
  // ---------------------------------------------------------------------
  const state = {
    mode: "menu",       // menu | play | riddle | win | dead
    levelIndex: 0,
    time: 0,
    gatePrompt: 0,      // frames to show the "collect all clues" gate message
  };

  // ---------------------------------------------------------------------
  // Player
  // ---------------------------------------------------------------------
  const player = {
    x: 60, y: 300, w: 22, h: 38,
    vx: 0, vy: 0,
    onGround: false,
    facing: 1,
    aimX: 1, aimY: 0,   // aim direction (from joystick / keyboard), normalized
    hp: 100, maxHp: 100,
    shootCooldown: 0,
    bombCooldown: 0,
    webCooldown: 0,
    invuln: 0,
    coyote: 0,       // frames since last grounded (for coyote-time jumps)
    jumpBuffer: 0,   // frames since jump was pressed (for buffered jumps)
    reset(spawn) {
      this.x = spawn.x; this.y = spawn.y;
      this.vx = 0; this.vy = 0;
      this.onGround = false;
      this.hp = this.maxHp; this.invuln = 0; this.shootCooldown = 0;
      this.bombCooldown = 0; this.webCooldown = 0;
      this.coyote = 0; this.jumpBuffer = 0;
      this.facing = 1;
    }
  };

  const bullets = [];      // player bullets
  const enemyBullets = []; // hostile bullets
  const bombs = [];        // thrown bombs (arc + gravity)
  const explosions = [];   // active explosion effects (AoE + visual)

  // Web/grapple: when active, a line is drawn from the spy to a grabbed
  // target which is reeled toward the spy. { target, life } or null.
  let web = null;

  // ---------------------------------------------------------------------
  // Levels
  // Each level: platforms (solid rects), ladders, enemies, goal, spawn,
  // camera width, and a riddle to unlock the goal.
  // Coordinates are in world space; camera scrolls horizontally.
  // ---------------------------------------------------------------------
  function makeLevels() {
    return [
      // ---- LEVEL 1: the grand foyer ----
      {
        name: "The Grand Hall — Immersive Theater Tokyo",
        theme: "foyer",
        worldW: 2200,
        spawn: { x: 60, y: 400 },
        platforms: [
          // one continuous floor — no pits to fall into
          { x: 0, y: 460, w: 2200, h: 90 },
          // raised "stepped" sections sitting on the floor (walkable steps)
          { x: 380,  y: 410, w: 220, h: 50 },   // low step
          { x: 820,  y: 370, w: 200, h: 90 },   // taller block
          { x: 1150, y: 420, w: 160, h: 40 },   // low ledge
          { x: 1480, y: 360, w: 220, h: 100 },  // tall block (guard perches here)
          { x: 1850, y: 410, w: 200, h: 50 },   // low step near the exit
        ],
        // One picture torn into pieces — one piece per guard. Collect all,
        // then tape them together at the door to read the answer.
        clueImage: "lantern",   // a paper lantern — the answer to L1's riddle
        enemies: [
          { x: 620, y: 426, patrol: [520, 780], clue: 0 },     // on the floor / low step
          { x: 1560, y: 326, patrol: [1490, 1690], clue: 1 },  // up on the tall block
        ],
        goal: { x: 2120, y: 380, w: 40, h: 80 },
        riddle: {
          title: "The Grand Hall Door",
          text: "I hold a small fire but never burn the hand. I sway on a string and light the night's demand. What am I?",
          answers: ["lantern", "a lantern", "paper lantern"],
          hint: "Rows of these paper lights glow along the fort's halls."
        }
      },

      // ---- LEVEL 2: backstage ----
      {
        name: "Backstage — Rigging & Dressing Rooms",
        theme: "backstage",
        worldW: 2600,
        spawn: { x: 50, y: 400 },
        platforms: [
          { x: 0, y: 460, w: 2600, h: 90 },     // continuous floor
          { x: 300,  y: 410, w: 200, h: 50 },
          { x: 700,  y: 370, w: 220, h: 90 },   // tall block (guard up high)
          { x: 1100, y: 420, w: 180, h: 40 },
          { x: 1450, y: 360, w: 220, h: 100 },  // taller block (guard up high)
          { x: 1850, y: 415, w: 200, h: 45 },
          { x: 2200, y: 385, w: 220, h: 75 },
        ],
        clueImage: "mask",   // a theatrical mask — the answer to L2's riddle
        enemies: [
          { x: 560, y: 426, patrol: [520, 660], clue: 0 },      // floor
          { x: 780, y: 336, patrol: [710, 900], clue: 1 },      // on tall block
          { x: 1520, y: 326, patrol: [1460, 1660], clue: 2 },   // on taller block
          { x: 2260, y: 351, patrol: [2210, 2410], clue: 3 },   // on the raised block near exit
        ],
        goal: { x: 2520, y: 380, w: 40, h: 80 },
        riddle: {
          title: "The Dressing Room Lock",
          text: "I have a face that is not my own, worn on a stage where true selves are unknown. What am I?",
          answers: ["mask", "a mask", "theatre mask", "theater mask"],
          hint: "Every actor in the fort hides behind one of these."
        }
      },

      // ---- LEVEL 3: the catwalk ----
      {
        name: "The Catwalk — Stage Lighting Gantry",
        theme: "catwalk",
        worldW: 2400,
        spawn: { x: 50, y: 400 },
        platforms: [
          { x: 0, y: 460, w: 2400, h: 90 },     // continuous floor
          { x: 360,  y: 405, w: 220, h: 55 },
          { x: 760,  y: 365, w: 220, h: 95 },   // tall block (guard up high)
          { x: 1150, y: 415, w: 180, h: 45 },
          { x: 1500, y: 360, w: 240, h: 100 },  // taller block (guard up high)
          { x: 1950, y: 410, w: 220, h: 50 },
        ],
        clueImage: "key",   // a key — the answer to L3's riddle
        enemies: [
          { x: 830, y: 331, patrol: [770, 970], clue: 0 },      // on tall block
          { x: 1200, y: 426, patrol: [1120, 1340], clue: 1 },   // floor / low ledge
          { x: 1580, y: 326, patrol: [1510, 1730], clue: 2 },   // on taller block
        ],
        goal: { x: 2320, y: 380, w: 40, h: 80 },
        riddle: {
          title: "The Catwalk Gate",
          text: "Teeth that never chew, a body thin and worn; I turn once in the dark and a locked path is born. What am I?",
          answers: ["key", "a key"],
          hint: "It fits the lock that guards the final act."
        }
      },

      // ---- LEVEL 4: BOSS ----
      {
        name: "The Grand Stage — Final Curtain",
        theme: "stage",
        worldW: 960,
        spawn: { x: 80, y: 360 },
        platforms: [
          { x: 0,   y: 470, w: 960, h: 70 },
          { x: 120, y: 360, w: 120, h: 20 },
          { x: 720, y: 360, w: 120, h: 20 },
          { x: 420, y: 280, w: 120, h: 20 },
        ],
        enemies: [],
        goal: null,
        isBoss: true
      }
    ];
  }

  let levels = makeLevels();
  let level = null;
  let enemies = [];
  let boss = null;
  let camX = 0;

  // ---------------------------------------------------------------------
  // Enemy factory
  // ---------------------------------------------------------------------
  function spawnEnemy(def) {
    const patrol = def.patrol.slice();
    return {
      x: def.x, y: def.y, w: 24, h: 34,
      vx: 1, vy: 0,
      dir: 1,
      onGround: false,
      patrol: patrol,
      patrolHalf: (patrol[1] - patrol[0]) / 2, // to recenter patrol after a pull
      hp: 30, maxHp: 30,
      hitFlash: 0,     // frames of white flash after a hit
      showHp: 0,       // frames to keep the health bar visible after a hit
      stun: 0,         // frames stunned (can't move/shoot) after being webbed
      webbed: false,   // currently being reeled in by the web
      clue: (typeof def.clue === "number") ? def.clue : -1, // clue piece this guard carries
      shootTimer: 60 + Math.random() * 90,
      alive: true,
    };
  }

  // Collectible clue pieces dropped by killed guards, and the set the
  // player has collected on the current level.
  let clues = [];              // active pickups in the world
  let collectedClues = [];     // clue ids the player has picked up (this level)

  function loadLevel(index) {
    level = levels[index];
    player.reset(level.spawn);
    enemies = (level.enemies || []).map(spawnEnemy);
    bullets.length = 0;
    enemyBullets.length = 0;
    bombs.length = 0;
    explosions.length = 0;
    web = null;
    clues = [];
    collectedClues = [];
    camX = 0;
    boss = null;
    if (level.isBoss) {
      boss = {
        x: 720, y: 360, w: 70, h: 110,
        vx: 2, dir: -1,
        hp: 300, maxHp: 300,
        phase: 0,
        shootTimer: 40,
        chargeTimer: 0,
        alive: true,
      };
    }
  }

  // Spawn a collectible clue where a guard died (if that guard carried one).
  function dropClue(e) {
    if (!e || e.clue < 0 || !level.clueImage) return;
    clues.push({
      id: e.clue,                 // which torn piece (0..pieces-1)
      x: e.x + e.w / 2,
      y: e.y + e.h / 2,
      vy: 0,
      landed: false,
      baseY: 0,
      bob: Math.random() * Math.PI * 2,
      collected: false,
    });
  }

  // Number of torn pieces = number of guards on this level.
  function totalClues() { return level.clueImage ? (level.enemies ? level.enemies.length : 0) : 0; }
  function allCluesCollected() { return collectedClues.length >= totalClues(); }

  // Clue pickups fall to the ground, then bob in place; collected on contact.
  function updateClues() {
    for (const c of clues) {
      if (c.collected) continue;
      if (!c.landed) {
        c.vy += GRAVITY;
        if (c.vy > MAX_FALL) c.vy = MAX_FALL;
        c.y += c.vy;
        // land on the first platform top beneath the clue
        const box = { x: c.x - 10, y: c.y - 10, w: 20, h: 20 };
        for (const p of level.platforms) {
          if (rectsOverlap(box, p) && c.vy >= 0) {
            c.y = p.y - 10;      // rest just above the surface
            c.vy = 0; c.landed = true; c.baseY = c.y;
            break;
          }
        }
      } else {
        c.bob += 0.08;
        c.y = c.baseY + Math.sin(c.bob) * 4;
      }
      const pick = { x: c.x - 16, y: c.y - 16, w: 32, h: 32 };
      if (rectsOverlap(player, pick)) {
        c.collected = true;
        if (!collectedClues.includes(c.id)) {
          collectedClues.push(c.id);
          Sfx.shoot(); // light pickup blip
        }
      }
    }
  }

  // Move both axes, then for each overlapping platform push the entity out
  // along the axis of LEAST penetration (minimum translation vector). This
  // is robust against corner cases and never "wedges" an entity in place.
  // ---------------------------------------------------------------------
  function collidePlatforms(entity, platforms) {
    entity.onGround = false;

    entity.x += entity.vx;
    entity.y += entity.vy;

    // Resolve a few iterations so multi-platform overlaps settle cleanly.
    for (let iter = 0; iter < 3; iter++) {
      let resolvedAny = false;
      for (const p of platforms) {
        if (!rectsOverlap(entity, p)) continue;

        // Overlap depth on each axis.
        const overlapLeft   = (entity.x + entity.w) - p.x;      // pushing entity left
        const overlapRight  = (p.x + p.w) - entity.x;           // pushing entity right
        const overlapTop    = (entity.y + entity.h) - p.y;      // pushing entity up
        const overlapBottom = (p.y + p.h) - entity.y;           // pushing entity down

        const minX = Math.min(overlapLeft, overlapRight);
        const minY = Math.min(overlapTop, overlapBottom);

        if (minX < minY) {
          // Resolve horizontally.
          if (overlapLeft < overlapRight) { entity.x = p.x - entity.w; }
          else { entity.x = p.x + p.w; }
          entity.vx = 0;
        } else {
          // Resolve vertically.
          if (overlapTop < overlapBottom) {
            entity.y = p.y - entity.h;
            entity.onGround = true;
          } else {
            entity.y = p.y + p.h;
          }
          entity.vy = 0;
        }
        resolvedAny = true;
      }
      if (!resolvedAny) break;
    }
  }

  // ---------------------------------------------------------------------
  // Update: player
  // ---------------------------------------------------------------------
  function updateAim() {
    let ax = 0, ay = 0;
    if (touchAim.active && (Math.abs(touchAim.x) > 0.2 || Math.abs(touchAim.y) > 0.2)) {
      // aiming via a drag on an action button (shoot/bomb/web)
      ax = touchAim.x; ay = touchAim.y;
    } else {
      // keyboard: horizontal from facing, vertical from up/down keys
      ax = player.facing;
      if (keys["w"] || keys["ArrowUp"]) ay = -1;
      else if (keys["s"] || keys["ArrowDown"]) ay = 1;
      if (keys["a"] || keys["ArrowLeft"]) ax = -1;
      else if (keys["d"] || keys["ArrowRight"]) ax = 1;
    }
    if (ax === 0 && ay === 0) ax = player.facing;
    const len = Math.hypot(ax, ay) || 1;
    player.aimX = ax / len;
    player.aimY = ay / len;
  }

  function updatePlayer() {
    // Horizontal movement (arrow buttons / keyboard).
    if (LEFT())       { player.vx = -MOVE_SPEED; player.facing = -1; }
    else if (RIGHT()) { player.vx = MOVE_SPEED;  player.facing = 1; }
    else { player.vx *= FRICTION; if (Math.abs(player.vx) < 0.1) player.vx = 0; }

    // Aim direction: from a drag on an action button, else keyboard, else facing.
    updateAim();

    // Jump — with coyote time (grace after leaving a ledge) and jump
    // buffering (press slightly before landing still registers).
    if (JUMP()) player.jumpBuffer = JUMP_BUFFER;
    if (player.jumpBuffer > 0) player.jumpBuffer--;

    const canJump = player.onGround || player.coyote > 0;
    if (player.jumpBuffer > 0 && canJump) {
      player.vy = JUMP_VELOCITY;
      player.onGround = false;
      player.coyote = 0;
      player.jumpBuffer = 0;
      Sfx.jump();
    }

    // Gravity
    player.vy += GRAVITY;
    if (player.vy > MAX_FALL) player.vy = MAX_FALL;

    collidePlatforms(player, level.platforms);

    // Coyote time: refresh when grounded, otherwise count down.
    if (player.onGround) player.coyote = COYOTE_FRAMES;
    else if (player.coyote > 0) player.coyote--;

    // World bounds
    if (player.x < 0) player.x = 0;
    if (player.x + player.w > level.worldW) player.x = level.worldW - player.w;

    // Fell off the world
    if (player.y > H + 200) damagePlayer(35, true);

    // Shooting — fires along the aim direction (joystick / keyboard).
    if (player.shootCooldown > 0) player.shootCooldown--;
    if (SHOOT() && player.shootCooldown === 0) {
      const speed = 9.5;
      const cx = player.x + player.w / 2;
      const cy = player.y + 14;
      bullets.push({
        x: cx + player.aimX * 14 - 4,
        y: cy + player.aimY * 14 - 2,
        w: 8, h: 4,
        vx: player.aimX * speed,
        vy: player.aimY * speed,
      });
      player.shootCooldown = 12;
      Sfx.shoot();
    }

    // Throwing bombs — lobbed in an arc in the facing direction.
    if (player.bombCooldown > 0) player.bombCooldown--;
    if (BOMB() && player.bombCooldown === 0) {
      throwBomb();
      player.bombCooldown = 45;
    }

    // Web/grapple — throw toward the facing direction, grab the nearest
    // guard/boss in range and reel them in.
    if (player.webCooldown > 0) player.webCooldown--;
    if (WEB() && player.webCooldown === 0) {
      throwWeb();
      player.webCooldown = 40;
    }

    if (player.invuln > 0) player.invuln--;

    // Reach goal -> riddle gate (only once all clue pieces are collected).
    if (level.goal && rectsOverlap(player, level.goal)) {
      if (allCluesCollected()) {
        openRiddle();
      } else {
        state.gatePrompt = 90; // show "collect all clues" message briefly
      }
    }
  }

  // Lob a bomb: gravity-affected projectile that arcs forward/down and
  // explodes on impact with ground, an enemy, the boss, or when the fuse ends.
  function throwBomb() {
    bombs.push({
      x: player.x + player.w / 2,
      y: player.y + 6,
      w: 12, h: 12,
      vx: player.facing * 6.2,
      vy: -6.5,            // initial upward toss for the arc
      fuse: 150,
      spin: 0,
    });
    Sfx.jump(); // a light "toss" whoosh (reuse)
  }

  // ---------------------------------------------------------------------
  // Web / grapple: throw toward the facing direction, grab the nearest
  // guard (or the boss) within range and reel them toward the spy, dealing
  // light damage + a brief stun.
  // ---------------------------------------------------------------------
  const WEB_RANGE = 340;
  const WEB_DAMAGE = 14;
  const WEB_STUN = 70;      // frames the target is stunned after being pulled

  function throwWeb() {
    Sfx.shoot(); // a quick "thwip"
    const px = player.x + player.w / 2;
    const py = player.y + player.h / 2;
    let best = null, bestDist = WEB_RANGE;

    // Consider guards in front of the spy (in the facing direction).
    for (const e of enemies) {
      if (!e.alive) continue;
      const ex = e.x + e.w / 2;
      const dx = ex - px;
      if (Math.sign(dx) !== player.facing && Math.abs(dx) > 8) continue; // must be ahead
      const dist = Math.hypot(ex - px, (e.y + e.h / 2) - py);
      if (dist < bestDist) { bestDist = dist; best = e; }
    }
    // The boss can also be grabbed.
    if (boss && boss.alive) {
      const bx = boss.x + boss.w / 2;
      const dx = bx - px;
      if (Math.sign(dx) === player.facing || Math.abs(dx) <= 8) {
        const dist = Math.hypot(bx - px, (boss.y + boss.h / 2) - py);
        if (dist < bestDist) { bestDist = dist; best = boss; }
      }
    }

    if (best) {
      web = { target: best, life: 26, damaged: false };
      best.webbed = true;
    } else {
      // a short "miss" web that just flicks out and retracts
      web = { target: null, life: 10, damaged: false,
              endX: px + player.facing * WEB_RANGE, endY: py };
    }
  }

  function updateWeb() {
    if (!web) return;
    web.life--;
    const t = web.target;
    if (t && t.alive) {
      // Reel the target toward a point a little in FRONT of the spy (not on
      // top), so it doesn't collide with the player — leaving room to shoot.
      const STOP_GAP = 82; // px in front of the spy the guard is reeled to
      const px = player.x + player.w / 2;
      const targetX = px + player.facing * STOP_GAP; // where we pull them to
      const tx = t.x + t.w / 2;
      const pull = (targetX - tx) * 0.28;  // ease the enemy toward that point
      t.x += pull;
      t.stun = WEB_STUN;                   // keep them stunned while/after reeling
      t.showHp = 120;
      if (!web.damaged) {
        web.damaged = true;
        t.hitFlash = 6;
        if (t === boss) {
          boss.hp -= WEB_DAMAGE;
          Sfx.bossHit();
          if (boss.hp <= 0) { boss.hp = 0; boss.alive = false; onBossDefeated(); }
        } else {
          t.hp -= WEB_DAMAGE;
          Sfx.hit();
          if (t.hp <= 0) { t.alive = false; Sfx.enemyDown(); dropClue(t); }
        }
      }
    }
    if (web.life <= 0) {
      if (t) t.webbed = false;
      web = null;
    }
  }

  const EXPLOSION_RADIUS = 78;
  const EXPLOSION_DAMAGE = 45;

  function detonate(x, y) {
    explosions.push({ x, y, r: 6, max: EXPLOSION_RADIUS, life: 22 });
    Sfx.enemyDown();
    // Damage all enemies within the blast radius.
    for (const e of enemies) {
      if (!e.alive) continue;
      const ex = e.x + e.w / 2, ey = e.y + e.h / 2;
      if (Math.hypot(ex - x, ey - y) <= EXPLOSION_RADIUS) {
        e.hp -= EXPLOSION_DAMAGE;
        e.hitFlash = 6; e.showHp = 120;
        if (e.hp <= 0) { e.alive = false; dropClue(e); }
      }
    }
    // Damage the boss if in range.
    if (boss && boss.alive) {
      const bx = boss.x + boss.w / 2, by = boss.y + boss.h / 2;
      if (Math.hypot(bx - x, by - y) <= EXPLOSION_RADIUS + 20) {
        boss.hp -= EXPLOSION_DAMAGE;
        Sfx.bossHit();
        if (boss.hp <= 0) { boss.hp = 0; boss.alive = false; onBossDefeated(); }
      }
    }
    // Blast can also hurt the player if they're too close.
    const px = player.x + player.w / 2, py = player.y + player.h / 2;
    if (Math.hypot(px - x, py - y) <= EXPLOSION_RADIUS) damagePlayer(12);
  }

  function damagePlayer(amount, respawnPos) {
    if (player.invuln > 0) return;
    player.hp -= amount;
    player.invuln = 60;
    Sfx.hurt();
    if (respawnPos) { player.x = level.spawn.x; player.y = level.spawn.y; player.vy = 0; }
    if (player.hp <= 0) {
      player.hp = 0;
      state.mode = "dead";
      Sfx.stopMusic();
      Sfx.lose();
      showMessage("Curtain Falls", "The Nightingale is down. Take it from the top.", "Retry Scene", () => {
        state.mode = "play";
        hideMessage();
        loadLevel(state.levelIndex);
        Sfx.startMusic();
      });
    }
  }

  // ---------------------------------------------------------------------
  // Update: enemies
  // ---------------------------------------------------------------------
  // Resolve an enemy vertically against the floor/blocks so it rests on the
  // ground beneath it (used for gravity + web-pulled guards landing).
  function landEnemy(e) {
    e.vy += GRAVITY;
    if (e.vy > MAX_FALL) e.vy = MAX_FALL;
    e.y += e.vy;
    e.onGround = false;

    // Resolve against each platform along the axis of least penetration so a
    // guard is pushed out of a block's side/top instead of sinking in.
    for (let iter = 0; iter < 3; iter++) {
      let resolved = false;
      for (const p of level.platforms) {
        if (!rectsOverlap(e, p)) continue;
        const overlapLeft   = (e.x + e.w) - p.x;   // push left
        const overlapRight  = (p.x + p.w) - e.x;   // push right
        const overlapTop    = (e.y + e.h) - p.y;   // push up (land on top)
        const overlapBottom = (p.y + p.h) - e.y;   // push down
        const minX = Math.min(overlapLeft, overlapRight);
        const minY = Math.min(overlapTop, overlapBottom);
        if (minX < minY) {
          if (overlapLeft < overlapRight) { e.x = p.x - e.w; e.dir = -1; }
          else { e.x = p.x + p.w; e.dir = 1; }
        } else {
          if (overlapTop < overlapBottom) { e.y = p.y - e.h; e.onGround = true; }
          else { e.y = p.y + p.h; }
          e.vy = 0;
        }
        resolved = true;
      }
      if (!resolved) break;
    }

    // keep within the world
    if (e.x < 0) e.x = 0;
    if (e.x + e.w > level.worldW) e.x = level.worldW - e.w;
  }

  function updateEnemies() {
    for (const e of enemies) {
      if (!e.alive) continue;

      if (e.hitFlash > 0) e.hitFlash--;
      if (e.showHp > 0) e.showHp--;

      // Gravity always applies so guards rest on the ground and any
      // web-pulled guard falls and lands (never floats).
      landEnemy(e);

      // While stunned (just webbed) the guard can't patrol or shoot, but it
      // still falls (handled above). When the stun ends, recenter its patrol
      // around wherever it landed so it resumes there and never snaps back.
      if (e.stun > 0) {
        e.stun--;
        if (e.stun === 0 && !e.webbed) {
          const c = e.x + e.w / 2;
          e.patrol = [c - e.patrolHalf, c + e.patrolHalf];
        }
        if (rectsOverlap(player, e)) damagePlayer(18);
        continue;
      }
      if (e.webbed) { // being reeled — don't patrol yet
        if (rectsOverlap(player, e)) damagePlayer(18);
        continue;
      }

      // Patrol (only meaningful when on the ground)
      e.x += e.vx * e.dir;
      if (e.x < e.patrol[0]) { e.x = e.patrol[0]; e.dir = 1; }
      if (e.x > e.patrol[1]) { e.x = e.patrol[1]; e.dir = -1; }

      // Face the player if in range and shoot
      const dx = (player.x) - e.x;
      const dist = Math.abs(dx);
      if (dist < 460) {
        e.dir = dx > 0 ? 1 : -1;
        e.shootTimer--;
        if (e.shootTimer <= 0) {
          enemyBullets.push({
            x: e.dir > 0 ? e.x + e.w : e.x - 6,
            y: e.y + 12, w: 7, h: 4,
            vx: e.dir * 5.5,
          });
          e.shootTimer = 90 + Math.random() * 70;
        }
      }

      // Contact damage
      if (rectsOverlap(player, e)) damagePlayer(18);
    }
  }

  // ---------------------------------------------------------------------
  // Update: boss
  // ---------------------------------------------------------------------
  function updateBoss() {
    if (!boss || !boss.alive) return;

    // Move back and forth on the platform
    boss.x += boss.vx * boss.dir;
    if (boss.x < 80) { boss.x = 80; boss.dir = 1; }
    if (boss.x + boss.w > level.worldW - 80) { boss.x = level.worldW - 80 - boss.w; boss.dir = -1; }

    // Aggression scales as hp drops
    const rage = 1 - boss.hp / boss.maxHp;

    boss.shootTimer--;
    if (boss.shootTimer <= 0) {
      const dir = (player.x > boss.x) ? 1 : -1;
      // spread shot
      const spread = rage > 0.5 ? [-2, 0, 2] : [0];
      for (const s of spread) {
        enemyBullets.push({
          x: boss.x + boss.w / 2, y: boss.y + 30,
          w: 9, h: 6, vx: dir * (5 + rage * 3), vy: s,
        });
      }
      boss.shootTimer = Math.max(24, 70 - rage * 40);
    }

    if (rectsOverlap(player, boss)) damagePlayer(24);
  }

  // ---------------------------------------------------------------------
  // Update: bullets
  // ---------------------------------------------------------------------
  function updateBullets() {
    // player bullets
    for (let i = bullets.length - 1; i >= 0; i--) {
      const b = bullets[i];
      b.x += b.vx;
      if (b.vy) b.y += b.vy;
      let hit = false;

      // vs platforms
      for (const p of level.platforms) {
        if (rectsOverlap(b, p)) { hit = true; break; }
      }
      // vs enemies
      if (!hit) {
        for (const e of enemies) {
          if (e.alive && rectsOverlap(b, e)) {
            e.hp -= 12;
            e.hitFlash = 6;
            e.showHp = 120; // keep the health bar up ~2s after a hit
            if (e.hp <= 0) { e.alive = false; Sfx.enemyDown(); dropClue(e); }
            else { Sfx.hit(); }
            hit = true;
            break;
          }
        }
      }
      // vs boss
      if (!hit && boss && boss.alive && rectsOverlap(b, boss)) {
        boss.hp -= 10;
        hit = true;
        Sfx.bossHit();
        if (boss.hp <= 0) { boss.hp = 0; boss.alive = false; onBossDefeated(); }
      }

      if (hit || b.x < -20 || b.x > level.worldW + 20 || b.y < -40 || b.y > H + 40) bullets.splice(i, 1);
    }

    // enemy bullets
    for (let i = enemyBullets.length - 1; i >= 0; i--) {
      const b = enemyBullets[i];
      b.x += b.vx;
      if (b.vy) b.y += b.vy;
      let hit = false;
      for (const p of level.platforms) {
        if (rectsOverlap(b, p)) { hit = true; break; }
      }
      if (!hit && rectsOverlap(b, player)) { damagePlayer(10); hit = true; }
      if (hit || b.x < -20 || b.x > level.worldW + 20) enemyBullets.splice(i, 1);
    }
  }

  // ---------------------------------------------------------------------
  // Update: bombs (arc + gravity) and explosions
  // ---------------------------------------------------------------------
  function updateBombs() {
    for (let i = bombs.length - 1; i >= 0; i--) {
      const b = bombs[i];
      b.vy += GRAVITY * 0.9;
      if (b.vy > MAX_FALL) b.vy = MAX_FALL;
      b.x += b.vx;
      b.y += b.vy;
      b.spin += 0.3;
      b.fuse--;

      let blow = false;
      // hit a platform (ground/wall)
      for (const p of level.platforms) {
        if (rectsOverlap(b, p)) { blow = true; break; }
      }
      // direct contact with an enemy or boss
      if (!blow) {
        for (const e of enemies) if (e.alive && rectsOverlap(b, e)) { blow = true; break; }
      }
      if (!blow && boss && boss.alive && rectsOverlap(b, boss)) blow = true;
      // fuse ran out or fell off world
      if (b.fuse <= 0 || b.y > H + 100) blow = true;

      if (blow) {
        detonate(b.x + b.w / 2, b.y + b.h / 2);
        bombs.splice(i, 1);
      }
    }
  }

  function updateExplosions() {
    for (let i = explosions.length - 1; i >= 0; i--) {
      const ex = explosions[i];
      ex.life--;
      ex.r += (ex.max - ex.r) * 0.35; // rapid expand
      if (ex.life <= 0) explosions.splice(i, 1);
    }
  }

  // ---------------------------------------------------------------------
  // Camera
  // ---------------------------------------------------------------------
  function updateCamera() {
    const target = player.x + player.w / 2 - W / 2;
    camX += (target - camX) * 0.12;
    camX = Math.max(0, Math.min(camX, level.worldW - W));
  }

  // ---------------------------------------------------------------------
  // Riddle gate
  // ---------------------------------------------------------------------
  const riddleOverlay = document.getElementById("riddle-overlay");
  const riddleTitle = document.getElementById("riddle-title");
  const riddleText = document.getElementById("riddle-text");
  const riddleInput = document.getElementById("riddle-input");
  const riddleSubmit = document.getElementById("riddle-submit");
  const riddleHint = document.getElementById("riddle-hint");
  const clueCanvas = document.getElementById("clue-canvas");
  const clueCtx = clueCanvas ? clueCanvas.getContext("2d") : null;

  // Reconstruct the ONE clue photo from its torn pieces on the riddle panel.
  // Each guard dropped strip `i` of `n`; collected strips are taped back
  // together to reveal the complete picture (the answer).
  function drawCluePuzzle() {
    if (!clueCtx) return;
    const cw = clueCanvas.width, ch = clueCanvas.height;
    clueCtx.clearRect(0, 0, cw, ch);
    const id = level.clueImage;
    const n = totalClues();
    if (!id || n === 0) return;

    // The full picture occupies a centered box; each strip is 1/n of its width.
    const imgW = Math.min(cw - 40, 360);
    const imgH = ch - 20;
    const cx = cw / 2, cy = ch / 2;
    const L = cx - imgW / 2;
    const stripW = imgW / n;

    for (let i = 0; i < n; i++) {
      const have = collectedClues.includes(i);
      const sL = L + i * stripW;
      if (have) {
        // draw this strip of the full image (taped in place)
        drawCluePieceStrip(id, i, n, cx, cy, imgW, imgH, clueCtx, true);
      } else {
        // torn gap placeholder for a missing piece
        clueCtx.fillStyle = "#14151f";
        clueCtx.fillRect(sL, cy - imgH / 2, stripW, imgH);
        clueCtx.strokeStyle = "#333a58";
        clueCtx.setLineDash([4, 4]);
        clueCtx.strokeRect(sL + 1, cy - imgH / 2 + 1, stripW - 2, imgH - 2);
        clueCtx.setLineDash([]);
        clueCtx.fillStyle = "#556";
        clueCtx.font = "20px sans-serif";
        clueCtx.textAlign = "center"; clueCtx.textBaseline = "middle";
        clueCtx.fillText("?", sL + stripW / 2, cy);
        clueCtx.textAlign = "left"; clueCtx.textBaseline = "alphabetic";
      }
    }
    // outer frame
    clueCtx.strokeStyle = allCluesCollected() ? "#31d17e" : "#7a6a3a";
    clueCtx.lineWidth = 2;
    clueCtx.strokeRect(L, cy - imgH / 2, imgW, imgH);
  }

  function openRiddle() {
    if (state.mode !== "play") return;
    state.mode = "riddle";
    const r = level.riddle;
    riddleTitle.textContent = r.title;
    riddleText.textContent = r.text;
    riddleInput.value = "";
    riddleHint.textContent = "💡 Hint: " + r.hint;
    const cap = document.getElementById("clue-caption");
    if (cap) cap.textContent = "The guards' torn photo, taped back together — what is it?";
    drawCluePuzzle();
    riddleOverlay.classList.remove("hidden");
    setTimeout(() => riddleInput.focus(), 30);
  }

  function submitRiddle() {
    const r = level.riddle;
    const guess = riddleInput.value.trim().toLowerCase().replace(/[.!?]/g, "");
    if (r.answers.includes(guess)) {
      riddleOverlay.classList.add("hidden");
      advanceLevel();
    } else {
      riddleHint.textContent = "❌ Access denied. 💡 Hint: " + r.hint;
      riddleInput.select();
    }
  }

  riddleSubmit.addEventListener("click", submitRiddle);
  riddleInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitRiddle();
  });

  function advanceLevel() {
    state.levelIndex++;
    if (state.levelIndex >= levels.length) {
      // shouldn't happen (boss handles win) but guard anyway
      onGameWin();
      return;
    }
    loadLevel(state.levelIndex);
    state.mode = "play";
  }

  // ---------------------------------------------------------------------
  // Message overlay (start / win / death)
  // ---------------------------------------------------------------------
  const msgOverlay = document.getElementById("msg-overlay");
  const msgTitle = document.getElementById("msg-title");
  const msgBody = document.getElementById("msg-body");
  const msgButton = document.getElementById("msg-button");

  function showMessage(title, body, buttonLabel, onClick) {
    msgTitle.textContent = title;
    msgBody.textContent = body;
    msgButton.textContent = buttonLabel;
    msgButton.onclick = onClick;
    msgOverlay.classList.remove("hidden");
  }
  function hideMessage() { msgOverlay.classList.add("hidden"); }

  function onBossDefeated() {
    Sfx.enemyDown();
    // brief delay so the defeat reads on screen
    setTimeout(onGameWin, 600);
  }

  // ===== BIRTHDAY MESSAGE =====
  const BIRTHDAY_NAME = "Risa-san";
  const BIRTHDAY_MESSAGE = "Happy Birthday Risa-san! You brought the house down at the immersive theater " +
    "and cleared the operation. Nice spy work and action there agent. Thank you for always answering " +
    "all my questions, even the stupid ones, and being patient with me and understanding my bad Japanese. " +
    "I wish you a very happy birthday, hope all your wishes come true!";

  function onGameWin() {
    state.mode = "win";
    Sfx.stopMusic();
    Sfx.happyBirthday();
    showMessage(
      "🎂 Happy Birthday, Risa-san! 🎉",
      BIRTHDAY_MESSAGE,
      "Encore (Play Again)",
      () => {
        levels = makeLevels();
        state.levelIndex = 0;
        loadLevel(0);
        state.mode = "play";
        hideMessage();
        Sfx.startMusic();
      }
    );
  }

  // ---------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------
  function draw() {
    ctx.clearRect(0, 0, W, H);
    drawBackground();

    ctx.save();
    ctx.translate(-camX, 0);

    drawPlatforms();
    drawGoal();
    drawClues();
    drawEnemies();
    drawBoss();
    drawBullets();
    drawBombs();
    drawExplosions();
    drawWeb();
    drawPlayer();

    ctx.restore();

    drawHUD();
  }

  function drawBackground() {
    const theme = level.theme || "foyer";

    // Deep interior gradient (warm theater dark).
    const g = ctx.createLinearGradient(0, 0, 0, H);
    if (theme === "stage") { g.addColorStop(0, "#2a0a14"); g.addColorStop(1, "#12060c"); }
    else if (theme === "backstage") { g.addColorStop(0, "#0f0d1a"); g.addColorStop(1, "#161020"); }
    else if (theme === "catwalk") { g.addColorStop(0, "#0a1020"); g.addColorStop(1, "#0e1428"); }
    else { g.addColorStop(0, "#1a0f22"); g.addColorStop(1, "#241436"); } // foyer
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // --- Neon Tokyo skyline seen through the theater's tall windows ---
    // (a lit cityscape behind the interior, parallax-scrolled)
    const winTop = 60, winBot = 300;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, winTop, W, winBot - winTop);
    ctx.clip();
    // night sky behind the window
    const sky = ctx.createLinearGradient(0, winTop, 0, winBot);
    sky.addColorStop(0, "#241a3a");
    sky.addColorStop(1, "#3a2050");
    ctx.fillStyle = sky;
    ctx.fillRect(0, winTop, W, winBot - winTop);
    // skyline
    const off = (camX * 0.25) % 130;
    const neon = ["#ff5c8a", "#6cc7ff", "#ffd166", "#8b5cff", "#31d17e"];
    for (let i = -1; i < W / 130 + 2; i++) {
      const bx = i * 130 - off;
      const bh = 70 + ((i * 47) % 120);
      ctx.fillStyle = "#160e28";
      ctx.fillRect(bx, winBot - bh, 96, bh);
      // neon window rows
      for (let wy = winBot - bh + 10; wy < winBot - 6; wy += 14) {
        ctx.fillStyle = neon[(i + Math.floor(wy)) % neon.length] + "";
        ctx.globalAlpha = 0.55;
        ctx.fillRect(bx + 8, wy, 70, 3);
        ctx.globalAlpha = 1;
      }
    }
    // a glowing full moon / lantern in the sky
    ctx.fillStyle = "#ffe1b0";
    ctx.beginPath();
    ctx.arc(W - 130, 120, 30, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // window frame mullions
    ctx.strokeStyle = "#3a2b18";
    ctx.lineWidth = 6;
    ctx.strokeRect(0, winTop, W, winBot - winTop);
    for (let x = 0; x < W; x += 240) {
      ctx.beginPath(); ctx.moveTo(x, winTop); ctx.lineTo(x, winBot); ctx.stroke();
    }

    // --- Stage curtains framing the scene (theater proscenium) ---
    const curtain = ctx.createLinearGradient(0, 0, 120, 0);
    curtain.addColorStop(0, "#7a0f22");
    curtain.addColorStop(1, "#3d0611");
    // left curtain
    ctx.fillStyle = curtain;
    for (let i = 0; i < 5; i++) ctx.fillRect(i * 22, 0, 20, H);
    // right curtain
    ctx.save();
    ctx.translate(W, 0); ctx.scale(-1, 1);
    ctx.fillStyle = curtain;
    for (let i = 0; i < 5; i++) ctx.fillRect(i * 22, 0, 20, H);
    ctx.restore();
    // valance (top curtain swag)
    ctx.fillStyle = "#5c0b1a";
    ctx.fillRect(0, 0, W, 26);
    ctx.fillStyle = "#ffcf5c";
    ctx.fillRect(0, 24, W, 3);

    // --- Spotlights sweeping the stage (subtle, animated) ---
    const sweep = Math.sin(state.time * 0.01) * 120;
    for (const sx of [W * 0.3 + sweep, W * 0.7 - sweep]) {
      const spot = ctx.createRadialGradient(sx, 40, 10, sx, 360, 260);
      spot.addColorStop(0, "rgba(255,240,200,0.16)");
      spot.addColorStop(1, "rgba(255,240,200,0)");
      ctx.fillStyle = spot;
      ctx.beginPath();
      ctx.moveTo(sx, 30);
      ctx.lineTo(sx - 160, H);
      ctx.lineTo(sx + 160, H);
      ctx.closePath();
      ctx.fill();
    }

    // --- Hanging paper lanterns (Tokyo flavor), parallax ---
    const lanternOff = (camX * 0.4) % 260;
    for (let i = -1; i < W / 260 + 2; i++) {
      const lx = i * 260 - lanternOff + 130;
      ctx.strokeStyle = "#2a1a2a"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(lx, 26); ctx.lineTo(lx, 70); ctx.stroke();
      ctx.fillStyle = i % 2 ? "#ff6b6b" : "#ffd166";
      ctx.beginPath(); ctx.ellipse(lx, 84, 14, 18, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.25)";
      ctx.fillRect(lx - 8, 78, 16, 3);
    }
  }

  function drawPlatforms() {
    for (const p of level.platforms) {
      // wooden stage structure
      const wood = ctx.createLinearGradient(0, p.y, 0, p.y + p.h);
      wood.addColorStop(0, "#5b3d24");
      wood.addColorStop(1, "#38251530");
      ctx.fillStyle = "#3a2716";
      ctx.fillRect(p.x, p.y, p.w, p.h);
      ctx.fillStyle = wood;
      ctx.fillRect(p.x, p.y, p.w, p.h);
      // plank seams
      ctx.strokeStyle = "rgba(0,0,0,0.25)";
      ctx.lineWidth = 1;
      for (let px = p.x + 24; px < p.x + p.w; px += 40) {
        ctx.beginPath(); ctx.moveTo(px, p.y); ctx.lineTo(px, p.y + p.h); ctx.stroke();
      }
      // gold-lit top edge (stage lighting)
      ctx.fillStyle = "#e8b74a";
      ctx.fillRect(p.x, p.y, p.w, 4);
      ctx.fillStyle = "rgba(255,220,140,0.5)";
      ctx.fillRect(p.x, p.y, p.w, 2);
    }
  }

  function drawGoal() {
    if (!level.goal) return;
    const gx = level.goal;
    // themed stage door
    ctx.fillStyle = "#8a1020";
    ctx.fillRect(gx.x, gx.y, gx.w, gx.h);
    ctx.fillStyle = "#e8b74a";
    ctx.fillRect(gx.x, gx.y, gx.w, 4);
    ctx.fillStyle = "#ffcf5c";
    ctx.font = "bold 11px sans-serif";
    ctx.fillText("STAGE", gx.x + 2, gx.y + gx.h / 2 - 4);
    ctx.fillText("DOOR", gx.x + 4, gx.y + gx.h / 2 + 10);

    // Floating riddle-hint sign shown when the player approaches the door,
    // so the hint is visible during gameplay (not just on the panel).
    if (level.riddle) {
      const near = Math.abs((player.x + player.w / 2) - (gx.x + gx.w / 2)) < 320;
      if (near) {
        const bx = gx.x + gx.w / 2, by = gx.y - 54;
        const hint = "💡 " + level.riddle.hint;
        ctx.font = "13px sans-serif";
        const tw = ctx.measureText(hint).width;
        const bw = Math.min(tw + 24, 360);
        // speech bubble
        ctx.fillStyle = "rgba(20,14,30,0.9)";
        ctx.strokeStyle = "#ffcf5c";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.rect(bx - bw / 2, by - 22, bw, 36);
        ctx.fill(); ctx.stroke();
        // wrapped hint text (single line, clipped)
        ctx.save();
        ctx.beginPath(); ctx.rect(bx - bw / 2 + 8, by - 22, bw - 16, 36); ctx.clip();
        ctx.fillStyle = "#ffe9b0";
        ctx.textAlign = "center";
        ctx.fillText(hint, bx, by, bw - 16);
        ctx.restore();
        ctx.textAlign = "left";
        ctx.fillStyle = "#ffcf5c";
        ctx.font = "10px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("Riddle at the door", bx, by + 28);
        ctx.textAlign = "left";
      }
    }
  }

  function drawPlayer() {
    if (player.invuln > 0 && Math.floor(state.time / 4) % 2 === 0) return; // blink
    const px = player.x, py = player.y;

    // body (spy suit)
    ctx.fillStyle = "#20243b";
    ctx.fillRect(px, py + 12, player.w, player.h - 12);
    // head
    ctx.fillStyle = "#e8c7a0";
    ctx.fillRect(px + 4, py, player.w - 8, 12);
    // ponytail (female spy cue)
    ctx.fillStyle = "#5b3a1e";
    ctx.fillRect(px + (player.facing > 0 ? -3 : player.w - 1), py + 1, 4, 14);
    // hair top
    ctx.fillStyle = "#5b3a1e";
    ctx.fillRect(px + 4, py - 2, player.w - 8, 5);
    // belt
    ctx.fillStyle = "#ff5c8a";
    ctx.fillRect(px, py + 22, player.w, 3);
    // gun + aim indicator — points in the aim direction
    const gx = px + player.w / 2;
    const gy = py + 18;
    const ax = player.aimX, ay = player.aimY;
    ctx.strokeStyle = "#c9ccd8";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(gx, gy);
    ctx.lineTo(gx + ax * 14, gy + ay * 14);
    ctx.stroke();
    // faint dotted aim line
    ctx.strokeStyle = "rgba(255,92,138,0.35)";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 5]);
    ctx.beginPath();
    ctx.moveTo(gx + ax * 16, gy + ay * 16);
    ctx.lineTo(gx + ax * 90, gy + ay * 90);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  function drawEnemies() {
    for (const e of enemies) {
      if (!e.alive) continue;
      const flash = e.hitFlash > 0;
      // body (flashes white briefly when hit)
      ctx.fillStyle = flash ? "#ffffff" : "#7a2230";
      ctx.fillRect(e.x, e.y, e.w, e.h);
      ctx.fillStyle = flash ? "#ffd0d0" : "#c23b4e";
      ctx.fillRect(e.x + 3, e.y, e.w - 6, 10);
      // gun
      ctx.fillStyle = "#20242f";
      if (e.dir > 0) ctx.fillRect(e.x + e.w, e.y + 14, 9, 4);
      else ctx.fillRect(e.x - 9, e.y + 14, 9, 4);

      // Floating health bar — shown for a moment after the soldier is hit.
      if (e.showHp > 0 && e.hp > 0) {
        const bw = 30, bh = 5;
        const bx = e.x + e.w / 2 - bw / 2;
        const by = e.y - 12;
        const frac = Math.max(0, e.hp / e.maxHp);
        // fade out over the last 30 frames
        ctx.globalAlpha = e.showHp < 30 ? e.showHp / 30 : 1;
        ctx.fillStyle = "#000a";
        ctx.fillRect(bx - 1, by - 1, bw + 2, bh + 2);
        ctx.fillStyle = "#3a1116";
        ctx.fillRect(bx, by, bw, bh);
        // color goes green -> yellow -> red as HP drops
        ctx.fillStyle = frac > 0.5 ? "#31d17e" : frac > 0.25 ? "#ffd166" : "#ff4d5e";
        ctx.fillRect(bx, by, bw * frac, bh);
        ctx.globalAlpha = 1;
      }
    }
  }

  function drawBoss() {
    if (!boss || !boss.alive) return;
    ctx.fillStyle = "#3a1140";
    ctx.fillRect(boss.x, boss.y, boss.w, boss.h);
    ctx.fillStyle = "#8b2bb0";
    ctx.fillRect(boss.x + 8, boss.y + 8, boss.w - 16, 30);
    // eyes
    ctx.fillStyle = "#ff3b6b";
    ctx.fillRect(boss.x + 16, boss.y + 18, 8, 8);
    ctx.fillRect(boss.x + boss.w - 24, boss.y + 18, 8, 8);
  }

  function drawBullets() {
    ctx.fillStyle = "#ffe66b";
    for (const b of bullets) ctx.fillRect(b.x, b.y, b.w, b.h);
    ctx.fillStyle = "#ff6b6b";
    for (const b of enemyBullets) ctx.fillRect(b.x, b.y, b.w, b.h);
  }

  function drawBombs() {
    for (const b of bombs) {
      const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(b.spin);
      // round black bomb
      ctx.fillStyle = "#1c1e28";
      ctx.beginPath(); ctx.arc(0, 0, 7, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "#3a3f52"; ctx.lineWidth = 1;
      ctx.stroke();
      // highlight
      ctx.fillStyle = "rgba(255,255,255,0.4)";
      ctx.beginPath(); ctx.arc(-2, -2, 2, 0, Math.PI * 2); ctx.fill();
      // fuse
      ctx.strokeStyle = "#a67c3d"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(0, -6); ctx.lineTo(3, -11); ctx.stroke();
      ctx.restore();
      // blinking fuse spark
      if (Math.floor(state.time / 4) % 2 === 0) {
        ctx.fillStyle = "#ffcf5c";
        ctx.beginPath(); ctx.arc(cx + 3, cy - 11, 2.4, 0, Math.PI * 2); ctx.fill();
      }
    }
  }

  function drawExplosions() {
    for (const ex of explosions) {
      const a = Math.max(0, ex.life / 22);
      // outer blast
      const g = ctx.createRadialGradient(ex.x, ex.y, 2, ex.x, ex.y, ex.r);
      g.addColorStop(0, "rgba(255,240,180," + a + ")");
      g.addColorStop(0.5, "rgba(255,140,60," + (a * 0.8) + ")");
      g.addColorStop(1, "rgba(255,60,60,0)");
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(ex.x, ex.y, ex.r, 0, Math.PI * 2); ctx.fill();
      // bright core
      ctx.fillStyle = "rgba(255,255,255," + a + ")";
      ctx.beginPath(); ctx.arc(ex.x, ex.y, ex.r * 0.3, 0, Math.PI * 2); ctx.fill();
    }
  }

  // Draw the web/grapple line from the spy's hand to the grabbed target.
  function drawWeb() {
    if (!web) return;
    const hx = player.x + player.w / 2 + player.facing * 8;
    const hy = player.y + 14;
    let ex, ey;
    if (web.target && web.target.alive) {
      ex = web.target.x + web.target.w / 2;
      ey = web.target.y + web.target.h / 2;
    } else {
      ex = web.endX; ey = web.endY;
    }
    // zig-zag web strand
    ctx.strokeStyle = "rgba(230,240,255,0.9)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(hx, hy);
    const segs = 6;
    for (let i = 1; i <= segs; i++) {
      const t = i / segs;
      const x = hx + (ex - hx) * t;
      const y = hy + (ey - hy) * t + (i < segs ? (i % 2 ? 3 : -3) : 0);
      ctx.lineTo(x, y);
    }
    ctx.stroke();
    // sticky tip
    ctx.fillStyle = "#eef4ff";
    ctx.beginPath(); ctx.arc(ex, ey, 4, 0, Math.PI * 2); ctx.fill();
  }

  // Draw the FULL clue picture (the answer image) filling the box centered
  // at (cx,cy) with width w and height h, onto context g.
  function drawClueImage(id, cx, cy, w, h, g) {
    g = g || ctx;
    const L = cx - w / 2, T = cy - h / 2;
    g.save();

    // If a real photo has been provided for this clue id, use it.
    const photo = ClueImages.get(id);
    if (photo) {
      // cover-fit the photo into the box, then a subtle frame
      g.save();
      g.beginPath(); g.rect(L, T, w, h); g.clip();
      const ar = photo.width / photo.height, boxAr = w / h;
      let dw, dh;
      if (ar > boxAr) { dh = h; dw = h * ar; } else { dw = w; dh = w / ar; }
      g.drawImage(photo, cx - dw / 2, cy - dh / 2, dw, dh);
      g.restore();
      g.strokeStyle = "#a67c3d";
      g.strokeRect(L, T, w, h);
      g.restore();
      return;
    }

    // Otherwise draw a placeholder illustration.
    // paper background for the photo
    g.fillStyle = "#f3ead2";
    g.fillRect(L, T, w, h);
    g.lineWidth = Math.max(1, w / 60);

    switch (id) {
      case "lantern": {
        // a hanging paper lantern
        // string + top cap
        g.strokeStyle = "#3a2a18"; g.lineWidth = Math.max(1, w / 80);
        g.beginPath(); g.moveTo(cx, T + h * 0.05); g.lineTo(cx, T + h * 0.16); g.stroke();
        g.fillStyle = "#2a1a10";
        g.fillRect(cx - w * 0.10, T + h * 0.14, w * 0.20, h * 0.05);
        // lantern body (glowing red-orange)
        const lg = g.createLinearGradient ? g.createLinearGradient(cx, T + h * 0.2, cx, T + h * 0.8) : null;
        if (lg) { lg.addColorStop(0, "#ff8a5c"); lg.addColorStop(0.5, "#e23b3b"); lg.addColorStop(1, "#a11f2a"); g.fillStyle = lg; }
        else g.fillStyle = "#e23b3b";
        g.beginPath();
        g.ellipse(cx, T + h * 0.5, w * 0.26, h * 0.34, 0, 0, Math.PI * 2);
        g.fill();
        // ribs
        g.strokeStyle = "rgba(90,10,10,0.6)"; g.lineWidth = Math.max(1, w / 120);
        for (let i = -2; i <= 2; i++) {
          g.beginPath();
          g.ellipse(cx + i * w * 0.09, T + h * 0.5, w * 0.05, h * 0.34, 0, 0, Math.PI * 2);
          g.stroke();
        }
        // bottom cap + tassel
        g.fillStyle = "#2a1a10";
        g.fillRect(cx - w * 0.08, T + h * 0.82, w * 0.16, h * 0.05);
        g.strokeStyle = "#c9a227"; g.lineWidth = Math.max(1, w / 90);
        g.beginPath(); g.moveTo(cx, T + h * 0.87); g.lineTo(cx, T + h * 0.95); g.stroke();
        break;
      }
      case "mask": {
        // a theatrical face mask
        g.fillStyle = "#e9e2d0";
        g.beginPath();
        g.ellipse(cx, cy, w * 0.26, h * 0.36, 0, 0, Math.PI * 2);
        g.fill();
        g.strokeStyle = "#8a6d10"; g.lineWidth = Math.max(1.5, w / 70);
        g.stroke();
        // eye holes (almond)
        g.fillStyle = "#20242f";
        g.beginPath(); g.ellipse(cx - w * 0.10, cy - h * 0.08, w * 0.06, h * 0.05, 0.2, 0, Math.PI * 2); g.fill();
        g.beginPath(); g.ellipse(cx + w * 0.10, cy - h * 0.08, w * 0.06, h * 0.05, -0.2, 0, Math.PI * 2); g.fill();
        // curved mouth
        g.strokeStyle = "#a11f2a"; g.lineWidth = Math.max(1.5, w / 70);
        g.beginPath(); g.arc(cx, cy + h * 0.02, w * 0.12, 0.2 * Math.PI, 0.8 * Math.PI); g.stroke();
        // brow/decoration
        g.strokeStyle = "#8a6d10";
        g.beginPath(); g.moveTo(cx - w * 0.16, cy - h * 0.16); g.quadraticCurveTo(cx, cy - h * 0.26, cx + w * 0.16, cy - h * 0.16); g.stroke();
        break;
      }
      case "key": {
        // an old-fashioned key lying horizontally
        g.fillStyle = "#d8b23a";
        // bow (round handle) on the left
        g.beginPath(); g.arc(cx - w * 0.22, cy, h * 0.18, 0, Math.PI * 2); g.fill();
        g.fillStyle = "#f3ead2";
        g.beginPath(); g.arc(cx - w * 0.22, cy, h * 0.08, 0, Math.PI * 2); g.fill(); // hole
        // shaft
        g.fillStyle = "#d8b23a";
        g.fillRect(cx - w * 0.10, cy - h * 0.05, w * 0.30, h * 0.10);
        // bit / teeth on the right
        g.fillRect(cx + w * 0.12, cy, w * 0.04, h * 0.16);
        g.fillRect(cx + w * 0.17, cy, w * 0.03, h * 0.12);
        // outline
        g.strokeStyle = "#8a6d10"; g.lineWidth = Math.max(1, w / 100);
        g.strokeRect(cx - w * 0.10, cy - h * 0.05, w * 0.30, h * 0.10);
        break;
      }
      default: {
        g.fillStyle = "#888";
        g.fillRect(L + 4, T + 4, w - 8, h - 8);
      }
    }
    // subtle photo border
    g.strokeStyle = "#a67c3d";
    g.strokeRect(L, T, w, h);
    g.restore();
  }

  // Draw a single torn PIECE (vertical strip `idx` of `n`) of the clue image,
  // positioned in a box at (cx,cy) of size (w,h). The strip is clipped so it
  // shows only its portion of the full picture — pieces tape back together.
  function drawCluePieceStrip(id, idx, n, cx, cy, w, h, g, taped) {
    g = g || ctx;
    const stripW = w / n;
    const stripL = cx - w / 2 + idx * stripW;
    g.save();
    // torn-paper backing for this piece
    g.beginPath();
    g.rect(stripL, cy - h / 2, stripW, h);
    g.clip();
    // draw the FULL image in the box; clipping leaves only this strip visible
    drawClueImage(id, cx, cy, w, h, g);
    g.restore();
    // torn/taped edges
    g.strokeStyle = taped ? "#d8c8a0" : "#7a6a3a";
    g.lineWidth = 1;
    g.strokeRect(stripL, cy - h / 2, stripW, h);
    if (taped) {
      // strips of "tape" over the seams
      g.fillStyle = "rgba(230,230,210,0.5)";
      if (idx > 0) g.fillRect(stripL - 6, cy - 8, 12, 16);
    }
  }

  // Backwards-compatible small icon used in the HUD / floating pickup:
  // draws piece `idx` of `n` of the level's clue image in a small box.
  function drawCluePieceIcon(idx, n, cx, cy, s, g) {
    drawCluePieceStrip(level.clueImage, idx, n, cx, cy, s, s, g, false);
  }

  // Floating clue pickups dropped by guards.
  function drawClues() {
    for (const c of clues) {
      if (c.collected) continue;
      // glowing scroll/note backing
      ctx.save();
      const pulse = 0.5 + 0.5 * Math.sin(state.time * 0.1);
      ctx.globalAlpha = 0.25 + 0.25 * pulse;
      ctx.fillStyle = "#ffd166";
      ctx.beginPath(); ctx.arc(c.x, c.y, 16, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
      // torn piece of the clue photo on a note card
      const n = totalClues();
      drawCluePieceStrip(level.clueImage, c.id, n, c.x, c.y, 26, 26, ctx, false);
      ctx.restore();
    }
  }

  function drawHUD() {
    // health bar
    ctx.fillStyle = "#000a";
    ctx.fillRect(16, 16, 204, 24);
    ctx.fillStyle = "#333a58";
    ctx.fillRect(18, 18, 200, 20);
    ctx.fillStyle = "#31d17e";
    ctx.fillRect(18, 18, 200 * (player.hp / player.maxHp), 20);
    ctx.fillStyle = "#fff";
    ctx.font = "bold 13px sans-serif";
    ctx.fillText("HP", 24, 33);

    // level name
    ctx.fillStyle = "#c3c9dc";
    ctx.font = "14px sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(`Level ${state.levelIndex + 1}: ${level.name}`, W - 16, 30);
    ctx.textAlign = "left";

    // clue counter (with mini collected image pieces)
    if (totalClues() > 0) {
      const cy = 58;
      const n = totalClues();
      ctx.fillStyle = "#000a";
      ctx.fillRect(16, cy - 16, 96 + n * 20, 30);
      ctx.fillStyle = "#ffd166";
      ctx.font = "bold 13px sans-serif";
      ctx.fillText(`Clues ${collectedClues.length}/${n}`, 24, cy + 3);
      // draw slots for each piece; filled ones show that torn strip
      for (let i = 0; i < n; i++) {
        const sx = 100 + i * 20, sy = cy - 1;
        ctx.strokeStyle = "#7a6a3a"; ctx.lineWidth = 1;
        ctx.strokeRect(sx - 8, sy - 8, 16, 16);
        if (collectedClues.includes(i)) {
          drawCluePieceStrip(level.clueImage, i, n, sx, sy, 16, 16, ctx, false);
        }
      }
    }

    // gate prompt: reached the door but missing clues
    if (state.gatePrompt > 0) {
      ctx.globalAlpha = Math.min(1, state.gatePrompt / 30);
      ctx.fillStyle = "#000b";
      ctx.fillRect(W / 2 - 210, H - 70, 420, 40);
      ctx.fillStyle = "#ffd166";
      ctx.font = "bold 15px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("The stage door is locked — collect all clue notes first!", W / 2, H - 45);
      ctx.textAlign = "left";
      ctx.globalAlpha = 1;
    }

    // boss health
    if (boss && boss.alive) {
      ctx.fillStyle = "#000a";
      ctx.fillRect(W / 2 - 202, 16, 404, 22);
      ctx.fillStyle = "#3a1140";
      ctx.fillRect(W / 2 - 200, 18, 400, 18);
      ctx.fillStyle = "#c23bff";
      ctx.fillRect(W / 2 - 200, 18, 400 * (boss.hp / boss.maxHp), 18);
      ctx.fillStyle = "#fff";
      ctx.textAlign = "center";
      ctx.font = "bold 12px sans-serif";
      ctx.fillText("THE IMPRESARIO", W / 2, 32);
      ctx.textAlign = "left";
    }
  }

  // ---------------------------------------------------------------------
  // Main loop
  // ---------------------------------------------------------------------
  function loop() {
    state.time++;
    if (state.mode === "play") {
      if (state.gatePrompt > 0) state.gatePrompt--;
      if (aimHold > 0) { aimHold--; if (aimHold === 0) { touchAim.active = false; touchAim.x = 0; touchAim.y = 0; } }
      if (shootPulse > 0) shootPulse--;
      updatePlayer();
      updateEnemies();
      updateBoss();
      updateBullets();
      updateBombs();
      updateExplosions();
      updateWeb();
      updateClues();
      updateCamera();
    }
    if (level) draw();
    requestAnimationFrame(loop);
  }

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------
  function startGame() {
    levels = makeLevels();
    state.levelIndex = 0;
    loadLevel(0);
    state.mode = "play";
    hideMessage();
    Sfx.unlock();      // resume AudioContext on this user gesture
    Sfx.startMusic();
    enterFullscreenLandscape(); // try to go fullscreen + lock landscape on phones
    fitCanvas();
  }

  // Initial menu
  loadLevel(0);              // load so we can render behind the menu
  state.mode = "menu";
  // Try to load real clue photos (fall back to drawn placeholders if absent).
  ClueImages.preload(["lantern", "mask", "key"]);
  showMessage(
    "Immersive Theater Tokyo",
    "Deep inside Immersive Theater Tokyo — a sprawling interactive theater — a secret is hidden. " +
    "You are the Nightingale, an elite spy. Move through the grand hall, the backstage rigging, and " +
    "the lighting catwalk. Take down the guards — each carries a torn piece of a photograph. Collect " +
    "every piece, tape the photo back together at each locked door to crack its riddle, then face " +
    "The Impresario for the final act. Lob bombs and fire your web to yank guards in close.",
    "Raise the Curtain",
    startGame
  );

  loop();
})();
