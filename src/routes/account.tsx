import { createFileRoute } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { changeOwnPassword } from "@/lib/server/auth";
import { setBearerToken } from "@/lib/auth/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

export const Route = createFileRoute("/account")({ component: AccountPage });

function AccountPage() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const mutation = useMutation({
    mutationFn: () => changeOwnPassword({ data: { currentPassword, newPassword, newPasswordConfirmation: confirmation } }),
    onSuccess: () => {
      setCurrentPassword("");
      setNewPassword("");
      setConfirmation("");
      setBearerToken(null);
      toast.success("密码已修改，请使用新密码重新登录");
      window.location.href = "/login";
    },
    onError: (error: Error) => toast.error(error.message),
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    mutation.mutate();
  }

  return (
    <div className="mx-auto max-w-lg space-y-5">
      <div>
        <h1 className="text-xl font-medium">修改密码</h1>
        <p className="mt-1 text-sm text-muted-foreground">验证当前密码后设置新密码；保存成功会让所有已有会话立即失效。</p>
      </div>
      <form className="grid gap-4 rounded-xl bg-card p-4 shadow-[var(--shadow-border)]" onSubmit={submit}>
        <div>
          <Label htmlFor="account-current-password">当前密码</Label>
          <Input id="account-current-password" type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} autoComplete="current-password" required />
        </div>
        <div>
          <Label htmlFor="account-new-password">新密码</Label>
          <Input id="account-new-password" type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} autoComplete="new-password" minLength={8} required />
        </div>
        <div>
          <Label htmlFor="account-confirm-password">确认新密码</Label>
          <Input id="account-confirm-password" type="password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="new-password" minLength={8} required />
        </div>
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? "保存中…" : "保存并重新登录"}
        </Button>
      </form>
    </div>
  );
}
