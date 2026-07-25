// Emoji picker: categories, search, recents, and workspace custom emoji.
// Self-contained (no CDN emoji data) so it works offline and inside the PWA.
import { el, esc } from '../util.js';
import { popover } from '../ui.js';

export const EMOJI_GROUPS = [
  ['Smileys', '😀 grin|smile,😃 smiley,😄 laugh,😁 beam,😆 lol,😅 sweat,🤣 rofl,😂 joy|lol|cry,🙂 slight,🙃 upside,😉 wink,😊 blush,😇 halo|angel,🥰 love|hearts,😍 heart eyes|love,🤩 star struck|wow,😘 kiss,😗 kissing,😚 kiss,😙 kiss,😋 yum|tasty,😛 tongue,😜 wink tongue,🤪 zany|crazy,😝 squint tongue,🤑 money,🤗 hug,🤭 oops,🤫 shh|quiet,🤔 think|thinking|hmm,🤐 zipper,🤨 raised brow|suspicious,😐 neutral,😑 expressionless,😶 no mouth,😏 smirk,😒 unamused,🙄 eye roll,😬 grimace|awkward,🤥 lying,😌 relieved,😔 pensive|sad,😪 sleepy,🤤 drool,😴 sleep|zzz,😷 mask,🤒 sick|fever,🤕 hurt|bandage,🤢 nauseated,🤮 vomit,🤧 sneeze,🥵 hot,🥶 cold,🥴 woozy,😵 dizzy,🤯 mind blown|explode,🤠 cowboy,🥳 party|celebrate,😎 cool|sunglasses,🤓 nerd|geek,🧐 monocle,😕 confused,😟 worried,🙁 frown,😮 open mouth|wow,😯 hushed,😲 astonished|shock,😳 flushed|blush,🥺 pleading|please,😦 frowning,😧 anguished,😨 fearful,😰 anxious,😥 sad,😢 cry,😭 sob|crying,😱 scream|fear,😖 confounded,😣 persevere,😞 disappointed,😓 downcast,😩 weary,😫 tired,🥱 yawn|bored,😤 triumph|angry,😡 rage|angry,😠 angry,🤬 cursing|swear,😈 devil|smiling imp,👿 imp,💀 skull|dead,☠️ skull crossbones,💩 poop,🤡 clown,👻 ghost,👽 alien,🤖 robot|bot'],
  ['Gestures', '👋 wave|hi|hello,🤚 raised back,🖐️ hand,✋ stop|high five,🖖 vulcan,👌 ok|perfect,🤌 pinch,🤏 small,✌️ victory|peace,🤞 fingers crossed|luck,🤟 love you,🤘 rock,🤙 call me|shaka,👈 left,👉 right,👆 up,👇 down,☝️ point up,👍 thumbs up|yes|+1|like|good,👎 thumbs down|no|-1|bad,✊ fist,👊 punch|bro fist,🤛 left fist,🤜 right fist,👏 clap|applause|bravo,🙌 raised hands|praise,👐 open hands,🤲 palms up,🤝 handshake|deal|agree,🙏 pray|thanks|please,✍️ writing,💅 nail,🤳 selfie,💪 muscle|strong|flex,🦾 mechanical arm,🧠 brain,👀 eyes|look|watching,👁️ eye,👄 mouth,🫡 salute,🫠 melting'],
  ['People', '👶 baby,🧒 child,👦 boy,👧 girl,🧑 person,👨 man,👩 woman,🧓 older,👴 old man,👵 old woman,🙍 frowning person,🙎 pouting,🙅 no|nope,🙆 ok gesture,💁 tipping hand|sassy,🙋 raising hand,🧏 deaf,🙇 bow|sorry,🤦 facepalm,🤷 shrug|dunno,👮 police,🕵️ detective|investigate,💂 guard,🥷 ninja,👷 construction,🤴 prince,👸 princess,👳 turban,🧕 headscarf,🤵 tuxedo,👰 veil,🤰 pregnant,🤱 nursing,🎅 santa,🦸 superhero,🦹 supervillain,🧙 mage|wizard,🧚 fairy,🧛 vampire,🧜 merperson,🧝 elf,🧞 genie,🧟 zombie,💆 massage,💇 haircut,🚶 walk,🧍 stand,🧎 kneel,🏃 run,💃 dance,🕺 dancing man,👯 bunny ears,🧖 sauna,🧗 climb,🤺 fencing,🏇 horse racing,⛷️ ski,🏂 snowboard,🏌️ golf,🏄 surf,🚣 row,🏊 swim,⛹️ ball,🏋️ weight lift,🚴 bike,🚵 mountain bike,🤸 cartwheel,🤼 wrestle,🤽 water polo,🤾 handball,🤹 juggle,🧘 yoga|meditate,🛀 bath,🛌 sleep'],
  ['Nature', '🐶 dog,🐱 cat,🐭 mouse,🐹 hamster,🐰 rabbit,🦊 fox,🐻 bear,🐼 panda,🐨 koala,🐯 tiger,🦁 lion,🐮 cow,🐷 pig,🐸 frog,🐵 monkey,🙈 see no evil,🙉 hear no evil,🙊 speak no evil,🐒 monkey,🐔 chicken,🐧 penguin,🐦 bird,🐤 chick,🦆 duck,🦅 eagle,🦉 owl,🦇 bat,🐺 wolf,🐗 boar,🐴 horse,🦄 unicorn,🐝 bee,🐛 bug,🦋 butterfly,🐌 snail,🐞 ladybug,🐜 ant,🦗 cricket,🕷️ spider,🦂 scorpion,🐢 turtle,🐍 snake,🦎 lizard,🦖 t-rex|dino,🦕 sauropod,🐙 octopus,🦑 squid,🦐 shrimp,🦀 crab,🐡 blowfish,🐠 fish,🐟 fish,🐬 dolphin,🐳 whale,🦈 shark,🐊 crocodile,🐅 tiger,🦓 zebra,🦍 gorilla,🐘 elephant,🦏 rhino,🐪 camel,🦒 giraffe,🐃 buffalo,🐎 horse,🐖 pig,🐏 ram,🐑 sheep,🦌 deer,🐕 dog,🐩 poodle,🦮 guide dog,🐈 cat,🐓 rooster,🦃 turkey,🦚 peacock,🦜 parrot,🦢 swan,🕊️ dove,🐇 rabbit,🦝 raccoon,🦡 badger,🐁 mouse,🐀 rat,🐿️ squirrel,🦔 hedgehog,🌵 cactus,🎄 christmas tree,🌲 evergreen,🌳 tree,🌴 palm,🌱 seedling,🌿 herb,☘️ shamrock,🍀 four leaf clover|luck,🎍 bamboo,🍃 leaf,🍂 fallen leaf,🍁 maple,🌾 rice,🌺 hibiscus,🌻 sunflower,🌹 rose,🥀 wilted,🌷 tulip,🌸 blossom,💐 bouquet,🍄 mushroom,🌰 chestnut,🌍 earth,🌙 moon,⭐ star,🌟 glowing star,✨ sparkles|magic,⚡ zap|lightning|fast,🔥 fire|lit|hot,💥 boom|explosion,❄️ snowflake|cold,🌊 wave|water,💧 droplet,☀️ sun,⛅ cloud,🌈 rainbow,☔ rain'],
  ['Food', '🍏 green apple,🍎 apple,🍐 pear,🍊 orange,🍋 lemon,🍌 banana,🍉 watermelon,🍇 grapes,🍓 strawberry,🫐 blueberry,🍈 melon,🍒 cherries,🍑 peach,🥭 mango,🍍 pineapple,🥥 coconut,🥝 kiwi,🍅 tomato,🍆 eggplant,🥑 avocado,🥦 broccoli,🥬 greens,🥒 cucumber,🌶️ hot pepper|spicy,🌽 corn,🥕 carrot,🧄 garlic,🧅 onion,🥔 potato,🍠 sweet potato,🥐 croissant,🥯 bagel,🍞 bread,🥖 baguette,🧀 cheese,🥚 egg,🍳 cooking|fried egg,🧈 butter,🥞 pancakes,🧇 waffle,🥓 bacon,🥩 steak|meat,🍗 poultry,🍖 meat,🌭 hot dog,🍔 burger,🍟 fries,🍕 pizza,🥪 sandwich,🥙 wrap,🧆 falafel,🌮 taco,🌯 burrito,🥗 salad,🥘 pan,🍲 stew,🍛 curry,🍜 ramen|noodles,🍝 spaghetti|pasta,🍣 sushi,🍱 bento,🥟 dumpling,🍤 fried shrimp,🍚 rice,🍘 rice cracker,🍥 fish cake,🥠 fortune cookie,🍦 ice cream,🍩 doughnut,🍪 cookie,🎂 birthday cake,🍰 cake,🧁 cupcake,🥧 pie,🍫 chocolate,🍬 candy,🍭 lollipop,🍯 honey,🍼 baby bottle,🥛 milk,☕ coffee,🍵 tea,🧃 juice box,🥤 cup,🧋 bubble tea,🍺 beer,🍻 cheers|beers,🥂 clink|celebrate,🍷 wine,🥃 whiskey,🍸 cocktail,🍹 tropical drink,🧉 mate,🍾 champagne|celebrate'],
  ['Activity', '⚽ soccer,🏀 basketball,🏈 football,⚾ baseball,🥎 softball,🎾 tennis,🏐 volleyball,🏉 rugby,🥏 frisbee,🎱 8 ball|pool,🪀 yo-yo,🏓 ping pong,🏸 badminton,🥅 goal,🏒 hockey,🏑 field hockey,🥍 lacrosse,🏏 cricket,🥊 boxing,🥋 martial arts,⛳ golf,⛸️ skate,🎣 fishing,🤿 diving,🎽 running shirt,🎿 skis,🛷 sled,🥌 curling,🎯 dart|target|bullseye,🪁 kite,🎮 game|gaming|controller,🕹️ joystick,🎰 slot machine,🎲 dice,🧩 puzzle,🎨 art|palette,🎭 theater,🎤 mic|sing,🎧 headphones,🎼 music score,🎹 piano,🥁 drum,🎺 trumpet,🎸 guitar,🎻 violin,🏆 trophy|win|first,🥇 gold|first,🥈 silver,🥉 bronze,🏅 medal,🎖️ military medal,🎫 ticket,🎪 circus,🎬 clapper|film,🎉 tada|party|celebrate|congrats,🎊 confetti,🎈 balloon,🎁 gift|present,🎀 ribbon,🧨 firecracker,🎇 sparkler,🎆 fireworks'],
  ['Objects', '⌚ watch,📱 phone,💻 laptop|computer,🖥️ desktop,🖨️ printer,⌨️ keyboard,🖱️ mouse,💽 disk,💾 floppy|save,💿 cd,📀 dvd,📷 camera,📹 video camera,🎥 movie camera,📞 telephone,☎️ phone,📟 pager,📠 fax,📺 tv,📻 radio,🎙️ studio mic,⏱️ stopwatch,⏰ alarm|clock,🕰️ clock,⌛ hourglass,🔋 battery,🔌 plug,💡 bulb|idea,🔦 flashlight,🕯️ candle,🧯 extinguisher,🛢️ oil drum,💸 money wings,💵 dollar,💴 yen,💶 euro,💷 pound,💰 money bag,💳 credit card,🧾 receipt,💎 gem|diamond,⚖️ balance|scales,🧰 toolbox,🔧 wrench|fix,🔨 hammer,⚒️ tools,🛠️ hammer wrench|build,⛏️ pick,🔩 bolt,⚙️ gear|settings,🧱 brick,⛓️ chains,🧲 magnet,🔫 water pistol,💣 bomb,🧨 dynamite,🪓 axe,🔪 knife,🗡️ dagger,⚔️ swords,🛡️ shield|protect|security,🚬 cigarette,⚰️ coffin,🏺 amphora,🔮 crystal ball,📿 beads,🧿 nazar,💈 barber,⚗️ alembic,🔭 telescope,🔬 microscope,🕳️ hole,💊 pill,💉 syringe,🩸 blood,🧬 dna,🦠 microbe,🧫 petri,🧪 test tube|experiment,🌡️ thermometer,🧹 broom|clean,🧺 basket,🧻 toilet paper,🚽 toilet,🚿 shower,🛁 bath,🧼 soap,🪒 razor,🧽 sponge,🛎️ bellhop,🔑 key,🗝️ old key,🚪 door,🪑 chair,🛏️ bed,🛋️ couch,🖼️ frame,🛍️ shopping bags,🎒 backpack,👑 crown,👒 hat,🎩 top hat,🧢 cap,⛑️ helmet,📿 prayer beads,💄 lipstick,💍 ring,👓 glasses,🕶️ sunglasses,🥽 goggles,🧥 coat,🦺 safety vest,👔 tie,👕 shirt,👖 jeans,🧣 scarf,🧤 gloves,🧦 socks,👗 dress,👘 kimono,🩳 shorts,👟 shoe,👞 loafer,🥾 boot,👠 heel,🩰 ballet'],
  ['Symbols', '❤️ heart|love|red heart,🧡 orange heart,💛 yellow heart,💚 green heart,💙 blue heart,💜 purple heart,🖤 black heart,🤍 white heart,🤎 brown heart,💔 broken heart,❣️ heart exclamation,💕 two hearts,💞 revolving hearts,💓 beating heart,💗 growing heart,💖 sparkling heart,💘 cupid,💝 heart gift,💟 heart decoration,☮️ peace,✝️ cross,☪️ star crescent,🕉️ om,☸️ dharma,✡️ star of david,🔯 six pointed,🕎 menorah,☯️ yin yang,☦️ orthodox cross,🛐 worship,⛎ ophiuchus,♈ aries,♉ taurus,♊ gemini,♋ cancer,♌ leo,♍ virgo,♎ libra,♏ scorpio,♐ sagittarius,♑ capricorn,♒ aquarius,♓ pisces,🆔 id,⚛️ atom,🉑 accept,☢️ radioactive,☣️ biohazard,📴 phone off,📳 vibration,🈶 not free,🈚 free,🈸 application,🈺 open for business,🈷️ monthly,✴️ eight pointed,🆚 vs,💮 white flower,🉐 bargain,㊙️ secret,㊗️ congratulations,🈴 passing,🈵 no vacancy,🈹 discount,🈲 prohibited,🅰️ a button,🅱️ b button,🆎 ab,🆑 cl,🅾️ o button,🆘 sos|help,❌ x|no|wrong|cross,⭕ o|circle,🛑 stop,⛔ no entry,📛 name badge,🚫 prohibited|no,💯 100|hundred|perfect,💢 anger,♨️ hot springs,🚷 no pedestrians,🚯 no littering,🚳 no bicycles,🚱 non potable,🔞 18,📵 no phones,❗ exclamation|important,❕ white exclamation,❓ question,❔ white question,‼️ double exclamation,⁉️ interrobang,🔅 dim,🔆 bright,〽️ part alternation,⚠️ warning|caution,🚸 children crossing,🔱 trident,⚜️ fleur de lis,🔰 beginner,♻️ recycle,✅ check|done|yes|white check,🈯 reserved,💹 chart up,❇️ sparkle,✳️ eight spoked,❎ negative check,🌐 globe,💠 diamond shape,Ⓜ️ circled m,🌀 cyclone,💤 zzz|sleep,🏧 atm,🚾 wc,♿ wheelchair,🅿️ parking,🈳 vacancy,🈂️ service charge,🛂 passport control,🛃 customs,🛄 baggage,🛅 left luggage,🚹 mens,🚺 womens,🚼 baby,🚻 restroom,🚮 litter,🎦 cinema,📶 signal,🈁 here,🔣 symbols,ℹ️ info,🔤 abc,🔡 lowercase,🔠 uppercase,🆖 ng,🆗 ok,🆙 up,🆒 cool,🆕 new,🆓 free,0️⃣ zero,1️⃣ one,2️⃣ two,3️⃣ three,4️⃣ four,5️⃣ five,6️⃣ six,7️⃣ seven,8️⃣ eight,9️⃣ nine,🔟 ten,🔢 numbers,#️⃣ hash,*️⃣ asterisk,⏏️ eject,▶️ play,⏸️ pause,⏯️ play pause,⏹️ stop,⏺️ record,⏭️ next track,⏮️ previous,⏩ fast forward,⏪ rewind,🔀 shuffle,🔁 repeat,🔂 repeat one,◀️ reverse,🔼 up small,🔽 down small,➡️ right arrow,⬅️ left arrow,⬆️ up arrow,⬇️ down arrow,↗️ up right,↘️ down right,↙️ down left,↖️ up left,↕️ up down,↔️ left right,↪️ right hook,↩️ left hook,⤴️ arrow up curve,⤵️ arrow down curve,🔃 clockwise,🔄 counterclockwise,🔚 end,🔙 back,🔛 on,🔝 top,🔜 soon,🔘 radio button,🔴 red circle,🟠 orange circle,🟡 yellow circle,🟢 green circle,🔵 blue circle,🟣 purple circle,⚫ black circle,⚪ white circle,🟥 red square,🟧 orange square,🟨 yellow square,🟩 green square,🟦 blue square,🟪 purple square,⬛ black square,⬜ white square,🔺 red triangle,🔻 down triangle,🔸 small orange diamond,🔹 small blue diamond,🔶 large orange diamond,🔷 large blue diamond,🔳 white square button,🔲 black square button,🏁 checkered flag|finish,🚩 triangular flag,🎌 crossed flags,🏴 black flag,🏳️ white flag,🏳️‍🌈 rainbow flag,🚀 rocket|launch|ship it|fast,🛸 ufo,🛰️ satellite,✈️ airplane,🚗 car,🚕 taxi,🚙 suv,🚌 bus,🚑 ambulance,🚒 fire engine,🚓 police car,🏎️ race car,🚚 truck,🚜 tractor,🛵 scooter,🏍️ motorcycle,🚲 bicycle,🛴 kick scooter,🚂 train,🚆 train,🚇 metro,🚊 tram,🚉 station,🚁 helicopter,⛵ sailboat,🚤 speedboat,🛥️ motor boat,🛳️ passenger ship,⛴️ ferry,🚢 ship,⚓ anchor,🏗️ construction,🏭 factory,🏢 office,🏬 department store,🏣 post office,🏥 hospital,🏦 bank,🏨 hotel,🏪 convenience store,🏫 school,🏛️ classical building,⛪ church,🕌 mosque,🛕 hindu temple,🕍 synagogue,⛩️ shinto shrine,🕋 kaaba,🏠 house,🏡 house garden,🏘️ houses,🏚️ derelict house,🏕️ camping,⛺ tent,🏖️ beach,🏝️ desert island,🏜️ desert,🌋 volcano,⛰️ mountain,🏔️ snow mountain,🗻 fuji,🏕️ camp'],
];

const parsed = EMOJI_GROUPS.map(([name, blob]) => ({
  name,
  items: blob.split(',').map((s) => {
    const sp = s.trim().indexOf(' ');
    const ch = sp === -1 ? s.trim() : s.trim().slice(0, sp);
    const kw = sp === -1 ? '' : s.trim().slice(sp + 1);
    return { ch, kw: kw.toLowerCase(), name: kw.split('|')[0] || ch };
  }),
}));

const ALL = parsed.flatMap((g) => g.items);

const RECENT_KEY = 'hearth.emoji.recent';
export function recentEmoji() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; }
}
export function noteEmoji(ch) {
  const r = recentEmoji().filter((x) => x !== ch);
  r.unshift(ch);
  localStorage.setItem(RECENT_KEY, JSON.stringify(r.slice(0, 36)));
}

export function searchEmoji(q) {
  q = (q || '').toLowerCase().trim();
  if (!q) return [];
  const starts = [], contains = [];
  for (const e of ALL) {
    if (e.kw.startsWith(q) || e.name.startsWith(q)) starts.push(e);
    else if (e.kw.includes(q)) contains.push(e);
    if (starts.length > 60) break;
  }
  return [...starts, ...contains].slice(0, 80);
}

// openEmojiPicker(anchorEl, onPick, {custom:[{name,url}]})
export function openEmojiPicker(anchor, onPick, opts = {}) {
  const box = el('div', 'emoji-picker');
  box.innerHTML = `
    <input class="emoji-search" placeholder="Search emoji" autocomplete="off" />
    <div class="emoji-tabs"></div>
    <div class="emoji-grid"></div>`;
  const search = box.querySelector('.emoji-search');
  const tabs = box.querySelector('.emoji-tabs');
  const grid = box.querySelector('.emoji-grid');

  const groups = [];
  const rec = recentEmoji();
  if (rec.length) groups.push({ name: 'Recent', items: rec.map((ch) => ({ ch, name: ch, kw: '' })) });
  if (opts.custom?.length) {
    groups.push({
      name: 'Custom',
      items: opts.custom.map((c) => ({ ch: `:${c.name}:`, url: c.url, name: c.name, kw: c.name })),
    });
  }
  groups.push(...parsed);

  const drawGrid = (items) => {
    grid.innerHTML = '';
    for (const e of items) {
      const b = el('button', 'emoji-cell');
      b.type = 'button';
      b.title = e.name;
      b.innerHTML = e.url ? `<img src="${esc(e.url)}" alt="${esc(e.name)}">` : esc(e.ch);
      b.onclick = () => { noteEmoji(e.ch); onPick(e.ch); pop.close(); };
      grid.appendChild(b);
    }
  };
  const drawGroup = (i) => {
    [...tabs.children].forEach((t, j) => t.classList.toggle('active', i === j));
    drawGrid(groups[i].items);
  };

  groups.forEach((g, i) => {
    const t = el('button', 'emoji-tab', esc(g.name));
    t.type = 'button';
    t.onclick = () => drawGroup(i);
    tabs.appendChild(t);
  });

  search.oninput = () => {
    const q = search.value.trim();
    if (!q) return drawGroup(0);
    [...tabs.children].forEach((t) => t.classList.remove('active'));
    drawGrid(searchEmoji(q));
  };
  search.onkeydown = (e) => {
    if (e.key === 'Enter') {
      const first = grid.querySelector('.emoji-cell');
      if (first) { e.preventDefault(); first.click(); }
    }
  };

  drawGroup(0);
  const pop = popover(anchor, box, { cls: 'popover-emoji' });
  setTimeout(() => search.focus(), 20);
  return pop;
}
