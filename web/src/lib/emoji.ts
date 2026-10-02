import { prefs } from './prefs';

/**
 * A curated emoji set (Unicode 13 or older, so phones on the other end can
 * display them) instead of a multi-hundred-KB picker library.
 */

export type EmojiCategory = 'smileys' | 'people' | 'animals' | 'food' | 'activities' | 'travel' | 'objects' | 'symbols' | 'flags';

const list = (s: string) => s.trim().split(/\s+/u);

export const EMOJI_CATEGORIES: { id: EmojiCategory; icon: string; emojis: string[] }[] = [
  {
    id: 'smileys',
    icon: '😀',
    emojis: list(`
      😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😗 😚 😙 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🤫 🤔
      🤐 🤨 😐 😑 😶 😏 😒 🙄 😬 🤥 😌 😔 😪 🤤 😴 😷 🤒 🤕 🤢 🤮 🤧 🥵 🥶 🥴 😵 🤯 🤠 🥳 😎 🤓
      🧐 😕 😟 🙁 😮 😯 😲 😳 🥺 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 😈 👿
      💀 💩 🤡 👻 👽 🤖 😺 😸 😹 😻 😼 😽 🙀 😿 😾 🙈 🙉 🙊
    `),
  },
  {
    id: 'people',
    icon: '👋',
    emojis: list(`
      👋 🤚 🖐️ ✋ 🖖 👌 🤏 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 👐 🤲 🤝 🙏 ✍️
      💅 🤳 💪 🦵 🦶 👂 👃 🧠 👀 👁️ 👅 👄 💋 👶 🧒 👦 👧 🧑 👨 👩 🧓 👴 👵 🙋 🙅 🙆 💁 🤷 🤦 🙇
      👮 🧑‍⚕️ 🧑‍🍳 🧑‍🔧 🧑‍💻 🧑‍🏫 👷 🤵 👰 🤰 🎅 🤶 🦸 🧙 🧚 🧛 🏃 🚶 💃 🕺 👯 🧘 👪 💑 💏
    `),
  },
  {
    id: 'animals',
    icon: '🐶',
    emojis: list(`
      🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🐔 🐧 🐦 🐤 🦆 🦅 🦉 🦇 🐺 🐗 🐴 🦄 🐝 🐛 🦋
      🐌 🐞 🐜 🕷️ 🐢 🐍 🦎 🐙 🦑 🦐 🦀 🐠 🐟 🐬 🐳 🐋 🦈 🐊 🐅 🐆 🦓 🦍 🐘 🦒 🦘 🐪 🐄 🐎 🐖 🐑
      🦙 🐐 🦌 🐕 🐩 🐈 🐓 🦃 🦚 🦜 🦢 🦩 🕊️ 🐇 🦝 🦨 🦡 🦦 🦥 🐁 🐿️ 🦔 🐾 🌵 🎄 🌲 🌳 🌴 🌱 🌿
      ☘️ 🍀 🍁 🍂 🍃 🍄 🌷 🌹 🥀 🌺 🌸 🌼 🌻 🌞 🌝 🌛 🌙 ⭐ 🌟 ✨ ⚡ 🔥 🌈 ☀️ ⛅ ☁️ 🌧️ ⛈️ ❄️ ☃️
      ⛄ 💧 🌊
    `),
  },
  {
    id: 'food',
    icon: '🍔',
    emojis: list(`
      🍏 🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🍈 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🍆 🥑 🥦 🥬 🥒 🌶️ 🌽 🥕 🧄 🧅 🥔 🍠 🥐
      🥯 🍞 🥖 🥨 🧀 🥚 🍳 🧈 🥞 🧇 🥓 🥩 🍗 🍖 🌭 🍔 🍟 🍕 🥪 🥙 🧆 🌮 🌯 🥗 🥘 🍝 🍜 🍲 🍛 🍣
      🍱 🥟 🍤 🍙 🍚 🍘 🍥 🥠 🍢 🍡 🍧 🍨 🍦 🥧 🧁 🍰 🎂 🍮 🍭 🍬 🍫 🍿 🍩 🍪 🌰 🥜 🍯 🥛 ☕ 🍵
      🧃 🥤 🍶 🍺 🍻 🥂 🍷 🥃 🍸 🍹 🧉 🍾 🧊 🥄 🍴 🍽️
    `),
  },
  {
    id: 'activities',
    icon: '⚽',
    emojis: list(`
      ⚽ 🏀 🏈 ⚾ 🥎 🎾 🏐 🏉 🥏 🎱 🏓 🏸 🏒 🏑 🥍 🏏 ⛳ 🏹 🎣 🥊 🥋 🎽 🛹 ⛸️ 🥌 🎿 ⛷️ 🏂 🏋️ 🤸
      ⛹️ 🤺 🤾 🏌️ 🏇 🧗 🚴 🏊 🏄 🚣 🏆 🥇 🥈 🥉 🏅 🎖️ 🎗️ 🎫 🎟️ 🎪 🎭 🎨 🎬 🎤 🎧 🎼 🎹 🥁 🎷 🎺
      🎸 🎻 🎲 ♟️ 🎯 🎳 🎮 🧩 🎉 🎊 🎈 🎁 🎀 🎃 🎄 🎆 🎇 🧨
    `),
  },
  {
    id: 'travel',
    icon: '✈️',
    emojis: list(`
      🚗 🚕 🚙 🚌 🚎 🏎️ 🚓 🚑 🚒 🚐 🚚 🚛 🚜 🛴 🚲 🛵 🏍️ 🚨 🚔 🚍 🚘 🚖 🚡 🚠 🚟 🚃 🚋 🚞 🚝 🚄
      🚅 🚈 🚂 🚆 🚇 🚊 🚉 ✈️ 🛫 🛬 💺 🚁 🚀 🛸 ⛵ 🚤 🛥️ 🛳️ ⛴️ 🚢 ⚓ ⛽ 🚧 🚦 🚥 🗺️ 🗽 🗼 🏰 🏯
      🏟️ 🎡 🎢 🎠 ⛲ ⛱️ 🏖️ 🏝️ 🏜️ 🌋 ⛰️ 🏔️ 🗻 🏕️ ⛺ 🏠 🏡 🏘️ 🏚️ 🏗️ 🏭 🏢 🏬 🏣 🏥 🏦 🏨 🏪 🏫 ⛪
      🕌 🏛️ 🌅 🌄 🌠 🎑 🏙️ 🌃 🌌 🌉 🌁
    `),
  },
  {
    id: 'objects',
    icon: '💡',
    emojis: list(`
      ⌚ 📱 💻 ⌨️ 🖥️ 🖨️ 🖱️ 💾 💿 📷 📸 📹 🎥 📞 ☎️ 📟 📠 📺 📻 🎙️ ⏰ ⏳ ⌛ 📡 🔋 🔌 💡 🔦 🕯️ 🧯
      💸 💵 💰 💳 💎 ⚖️ 🔧 🔨 🛠️ ⛏️ 🔩 ⚙️ 🧱 🔫 💣 🔪 🛡️ 🚬 ⚰️ 🔮 💈 🔭 🔬 💊 💉 🩹 🧬 🌡️ 🧹 🧺
      🧻 🚽 🚿 🛁 🧼 🧽 🔑 🗝️ 🚪 🛋️ 🛏️ 🧸 🖼️ 🛍️ 🛒 🎁 ✉️ 📩 📨 📧 💌 📦 🏷️ 📪 📬 📮 📜 📃 📄 📑
      📊 📈 📉 🗒️ 📆 📅 🗑️ 📇 🗃️ 📋 📁 📂 🗂️ 📰 📓 📔 📒 📕 📗 📘 📙 📚 📖 🔖 🔗 📎 🖇️ 📐 📏 📌
      📍 ✂️ 🖊️ 🖋️ ✒️ 🖌️ 🖍️ 📝 ✏️ 🔍 🔎 🔏 🔐 🔒 🔓
    `),
  },
  {
    id: 'symbols',
    icon: '❤️',
    emojis: list(`
      ❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟 ☮️ ✝️ ☯️ ☪️ 🕉️ ☸️ ✡️ 🔯 ♈ ♉ ♊
      ♋ ♌ ♍ ♎ ♏ ♐ ♑ ♒ ♓ 🆔 ⚛️ 🉑 ☢️ ☣️ 📴 📳 🈶 🈚 🆚 💮 🉐 ㊙️ ㊗️ 🅰️ 🅱️ 🆎 🆑 🅾️ 🆘 ❌
      ⭕ 🛑 ⛔ 📛 🚫 💯 💢 ♨️ 🚷 🚯 🚳 🚱 🔞 📵 🚭 ❗ ❕ ❓ ❔ ‼️ ⁉️ 🔅 🔆 〽️ ⚠️ 🚸 🔱 ⚜️ 🔰 ♻️
      ✅ 🈯 💹 ❇️ ✳️ ❎ 🌐 💠 Ⓜ️ 🌀 💤 🏧 🚾 ♿ 🅿️ 🚹 🚺 🚼 🚻 🚮 🎦 📶 🈁 🔣 ℹ️ 🔤 🔡 🔠 🆖 🆗
      🆙 🆒 🆕 🆓 0️⃣ 1️⃣ 2️⃣ 3️⃣ 4️⃣ 5️⃣ 6️⃣ 7️⃣ 8️⃣ 9️⃣ 🔟 🔢 #️⃣ *️⃣ ▶️ ⏸️ ⏹️ ⏺️ ⏭️ ⏮️ ⏩ ⏪ 🔀 🔁 🔂 ◀️
      🔼 🔽 ➡️ ⬅️ ⬆️ ⬇️ ↗️ ↘️ ↙️ ↖️ ↕️ ↔️ ↪️ ↩️ ⤴️ ⤵️ 🔄 🔃 🎵 🎶 ➕ ➖ ➗ ✖️ ♾️ 💲 💱 ™️ ©️ ®️
      ✔️ ☑️ 🔘 🔴 🟠 🟡 🟢 🔵 🟣 ⚫ ⚪ 🟤 🔺 🔻 🔸 🔹 🔶 🔷 🔳 🔲 ▪️ ▫️ ◾ ◽ ◼️ ◻️ 🟥 🟧 🟨 🟩
      🟦 🟪 ⬛ ⬜ 🟫 🔈 🔇 🔉 🔊 🔔 🔕 📣 📢 💬 💭 🗯️ ♠️ ♣️ ♥️ ♦️ 🃏 🎴 🀄 🕐 🕑 🕒 🕓 🕔 🕕
    `),
  },
  {
    id: 'flags',
    icon: '🏁',
    emojis: list(`
      🏁 🚩 🎌 🏴 🏳️ 🏳️‍🌈 🏴‍☠️ 🇨🇦 🇺🇸 🇲🇽 🇫🇷 🇧🇪 🇨🇭 🇬🇧 🇮🇪 🇩🇪 🇮🇹 🇪🇸 🇵🇹 🇳🇱 🇸🇪 🇳🇴 🇩🇰 🇫🇮 🇵🇱 🇺🇦 🇬🇷 🇹🇷 🇮🇳 🇨🇳
      🇯🇵 🇰🇷 🇻🇳 🇵🇭 🇦🇺 🇳🇿 🇧🇷 🇦🇷 🇨🇱 🇨🇴 🇵🇪 🇭🇹 🇨🇺 🇯🇲 🇩🇴 🇲🇦 🇩🇿 🇹🇳 🇸🇳 🇨🇮 🇨🇲 🇪🇬 🇿🇦 🇱🇧 🇮🇱
    `),
  },
];

const RECENT_KEY = 'emoji:recent';
const MAX_RECENT = 24;

/** Emojis this browser used last, most recent first. */
export function recentEmojis(): string[] {
  try {
    const value = JSON.parse(prefs.get(RECENT_KEY) ?? '[]') as unknown;
    return Array.isArray(value) ? value.filter((e): e is string => typeof e === 'string').slice(0, MAX_RECENT) : [];
  } catch {
    return [];
  }
}

export function rememberEmoji(emoji: string): void {
  const next = [emoji, ...recentEmojis().filter((e) => e !== emoji)].slice(0, MAX_RECENT);
  prefs.set(RECENT_KEY, JSON.stringify(next));
}
