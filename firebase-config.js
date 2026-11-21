// 把 Firebase 控制台里「项目设置 → 你的应用 → SDK 配置」中的内容粘贴到这里。
// 这些值本来就是公开在网页里的，不是密码；数据安全由 firestore.rules 保证。
// 留空时网站只把数据存在当前浏览器里。
export const FIREBASE_CONFIG = {
  apiKey: "",
  authDomain: "",
  projectId: "",
  storageBucket: "",
  messagingSenderId: "",
  appId: "",
};

// 只允许这些 Google 账号登录使用（留空数组 = 任何人都能登录，但每个人只能看到自己的数据）。
export const ALLOWED_EMAILS = [];
