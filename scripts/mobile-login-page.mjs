/** A dependency-free login document for mobile and degraded browser runtimes. */
export function renderStandaloneLoginPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="theme-color" content="#f3f2ee">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <title>登录 · 型号雷达</title>
  <style>
    *{box-sizing:border-box}html,body{margin:0;min-height:100%;background:#f3f2ee;color:#20201e;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans SC",sans-serif}
    body{min-height:100vh;min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:24px 16px}
    main{width:100%;max-width:384px;background:#fff;border:1px solid #dedbd4;border-radius:16px;padding:24px;box-shadow:0 10px 32px rgba(32,32,30,.08)}
    .eyebrow{margin:0;color:#77736c;font-size:12px}.title{margin:6px 0 0;font-size:22px;font-weight:600}.hint{margin:10px 0 22px;color:#66635d;font-size:14px;line-height:1.6}
    label{display:block;margin:14px 0 6px;font-size:14px;font-weight:500}input{display:block;width:100%;height:46px;border:1px solid #cbc7be;border-radius:10px;background:#fff;color:#20201e;padding:0 12px;font-size:16px;-webkit-appearance:none;appearance:none}
    input:focus{outline:2px solid #20201e;outline-offset:1px}button{display:block;width:100%;height:46px;margin-top:18px;border:0;border-radius:10px;background:#20201e;color:#fff;font-size:16px;font-weight:600}button:disabled{opacity:.6}
    #error{display:none;margin:12px 0 0;color:#b42318;font-size:14px;line-height:1.5;word-break:break-all}.noscript{color:#b42318;font-size:14px}
  </style>
</head>
<body>
  <main>
    <p class="eyebrow">型号雷达 · 安全登录</p>
    <h1 class="title">登录</h1>
    <p class="hint">请输入已分配的账号和密码。</p>
    <form id="login-form" novalidate>
      <label for="login-email">邮箱</label>
      <input id="login-email" name="email" type="email" inputmode="email" autocomplete="email" autocapitalize="none" required>
      <label for="login-password">密码</label>
      <input id="login-password" name="password" type="password" autocomplete="current-password" minlength="8" required>
      <p id="error" role="alert"></p>
      <button id="submit" type="submit">登录</button>
    </form>
    <noscript><p class="noscript">请开启浏览器 JavaScript 后登录。</p></noscript>
  </main>
  <script>
  (function () {
    var form = document.getElementById("login-form");
    var email = document.getElementById("login-email");
    var password = document.getElementById("login-password");
    var submit = document.getElementById("submit");
    var error = document.getElementById("error");

    function showError(message) {
      error.textContent = message;
      error.style.display = "block";
    }
    function resetButton() {
      submit.disabled = false;
      submit.textContent = "登录";
    }
    function goHome() {
      window.location.replace("/?_radar_refresh=" + String(Date.now()));
    }
    function request(method, path, body, done, timeout) {
      var xhr = new XMLHttpRequest();
      var completed = false;
      function finish(status, text) {
        if (completed) return;
        completed = true;
        done(status, text);
      }
      xhr.open(method, path, true);
      xhr.withCredentials = true;
      xhr.timeout = timeout || 15000;
      if (body !== null) xhr.setRequestHeader("content-type", "application/json");
      xhr.onreadystatechange = function () {
        if (xhr.readyState === 4) finish(xhr.status, xhr.responseText);
      };
      xhr.onerror = function () { finish(0, ""); };
      xhr.ontimeout = function () { finish(0, ""); };
      try {
        xhr.send(body);
      } catch (_e) {
        finish(0, "");
      }
    }
    function hasSessionUser(text) {
      try {
        var payload = JSON.parse(text || "");
        var user = payload && payload.user;
        return Boolean(user && (user.id || user.email));
      } catch (_e) {
        return false;
      }
    }
    function responseCode(text) {
      try {
        var payload = JSON.parse(text || "");
        return String((payload && (payload.code || payload.message)) || "");
      } catch (_e) {
        return "";
      }
    }
    function showLoginError(status, text) {
      if (status === 0) return showError("网络连接超时，请检查手机网络后重试。");
      if (status === 429) return showError("尝试次数过多，请稍后再试。");
      if (status === 400) {
        if (responseCode(text) === "INVALID_EMAIL") return showError("请输入有效的邮箱地址。");
        return showError("邮箱或密码错误，请重新输入。");
      }
      if (status === 401) return showError("邮箱或密码错误，请重新输入。");
      if (status === 403) return showError("登录校验失败，请刷新页面后重试。");
      showError("登录服务暂时不可用，请稍后重试。");
    }
    function confirmSession(startedAt, attempt) {
      request("GET", "/api/auth/get-session", null, function (status, text) {
        if (status === 200 && hasSessionUser(text)) {
          submit.textContent = "登录成功，正在进入…";
          goHome();
          return;
        }
        if (Date.now() - startedAt < 12000) {
          window.setTimeout(function () {
            confirmSession(startedAt, attempt + 1);
          }, Math.min(400 + attempt * 150, 1000));
          return;
        }
        resetButton();
        showError("登录已提交，但未能确认会话。请检查浏览器是否允许此站点 Cookie，然后重试。");
      }, 3000);
    }
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      error.style.display = "none";
      if (!email.value || !password.value) return showError("请输入邮箱和密码。");
      submit.disabled = true;
      submit.textContent = "登录中…";
      request("POST", "/api/auth/sign-in/email", JSON.stringify({
        email: email.value.replace(/^\\s+|\\s+$/g, ""),
        password: password.value
      }), function (status, text) {
        if (status >= 200 && status < 300) {
          submit.textContent = "正在确认会话…";
          confirmSession(Date.now(), 0);
          return;
        }
        resetButton();
        showLoginError(status, text);
      });
    });
  })();
  </script>
</body>
</html>`;
}
