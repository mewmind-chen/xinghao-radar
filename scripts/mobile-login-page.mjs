/** A dependency-free login document for mobile and degraded browser runtimes. */
export function renderStandaloneLoginPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="theme-color" content="#f3f2ee">
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
    <p class="hint">请使用分配给你的正式账号（如 yang@xinghao.local），默认密码 12345678。</p>
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
    function request(method, path, body, done) {
      var xhr = new XMLHttpRequest();
      xhr.open(method, path, true);
      xhr.withCredentials = true;
      xhr.timeout = 15000;
      if (body !== null) xhr.setRequestHeader("content-type", "application/json");
      xhr.onreadystatechange = function () {
        if (xhr.readyState === 4) done(xhr.status, xhr.responseText);
      };
      xhr.onerror = function () { done(0, ""); };
      xhr.ontimeout = function () { done(0, ""); };
      xhr.send(body);
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
          submit.textContent = "登录成功，正在进入…";
          request("GET", "/api/auth/get-session", null, function () {
            goHome();
          });
          return;
        }
        resetButton();
        if (status === 0) return showError("网络连接超时，请检查手机网络后重试。");
        if (status === 401 || status === 400) {
          var msg = "邮箱或密码错误，请核对后重试。";
          try {
            var j = JSON.parse(text || "");
            if (j && j.message) {
              if (j.message === "Invalid email or password" || j.message === "Invalid password") {
                msg = "邮箱或密码错误，请重新输入。";
              } else if (j.message === "User not found") {
                msg = "该账号不存在，请核对邮箱地址。";
              } else {
                msg = j.message;
              }
            }
          } catch (_e) {}
          return showError(msg);
        }
        if (status === 403) return showError("登录校验失败 (403)，请刷新页面后重试。");
        var detail = "";
        try { var j2 = JSON.parse(text || ""); if (j2 && j2.message) detail = "（" + j2.message + "）"; } catch (_e2) {}
        if (!detail && text) detail = "（" + text.slice(0, 120) + "）";
        showError("登录服务暂时不可用（" + status + "），请重试。" + detail);
      });
    });
  })();
  </script>
</body>
</html>`;
}
