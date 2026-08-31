import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { FormEvent, useEffect, useState } from "react";
import { authClient, authEnabled, setBearerToken } from "@/lib/auth/client";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const Route = createFileRoute("/login")({ component: LoginPage });

function LoginPage() {
  const nav = useNavigate();
  const { user, isPending } = useCurrentUserState();
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isPending && user) void nav({ to: "/" });
  }, [isPending, nav, user]);

  if (!authEnabled) {
    return <main className="grid min-h-dvh place-items-center p-6">认证配置未开启。</main>;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const result = mode === "signup"
        ? await authClient.signUp.email({ name: name.trim() || email.trim(), email: email.trim(), password })
        : await authClient.signIn.email({ email: email.trim(), password });
      if (result.error) throw new Error(result.error.message || "登录失败");
      if (result.data?.token) setBearerToken(result.data.token);
      await authClient.getSession();
      await nav({ to: "/" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="grid min-h-dvh place-items-center bg-background px-4 py-8">
      <section className="w-full max-w-sm rounded-2xl bg-card p-6 shadow-[var(--shadow-border)]">
        <div className="mb-6">
          <p className="text-xs text-muted-foreground">型号雷达 · 本地登录</p>
          <h1 className="mt-1 text-xl font-medium">{mode === "login" ? "登录" : "创建账号"}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            账号登录后由老板配置业务角色，未配置角色的账号不会获得业务数据权限。
          </p>
        </div>
        <form className="grid gap-3" onSubmit={submit}>
          {mode === "signup" && (
            <div>
              <Label htmlFor="login-name">姓名</Label>
              <Input id="login-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
            </div>
          )}
          <div>
            <Label htmlFor="login-email">邮箱</Label>
            <Input id="login-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
          </div>
          <div>
            <Label htmlFor="login-password">密码</Label>
            <Input id="login-password" type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === "login" ? "current-password" : "new-password"} />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit" disabled={busy} className="mt-1 w-full">
            {busy ? "处理中…" : mode === "login" ? "登录" : "创建账号"}
          </Button>
        </form>
        <button
          type="button"
          className="mt-4 w-full text-center text-sm text-muted-foreground underline-offset-4 hover:underline"
          onClick={() => { setMode(mode === "login" ? "signup" : "login"); setError(null); }}
        >
          {mode === "login" ? "首次使用？创建本地账号" : "已有账号？返回登录"}
        </button>
      </section>
    </main>
  );
}
