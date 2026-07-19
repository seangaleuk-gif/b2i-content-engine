"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const router = useRouter();
  const supabase = createClient();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      setError(error.message);
      setLoading(false);
    } else {
      router.push("/");
      router.refresh();
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg-primary">
      <div className="w-full max-w-md px-8">
        <div className="text-center mb-10">
          <h1 className="text-[32px] font-bold text-text-primary tracking-tight mb-2">
            B2I Content<span className="text-accent-primary"> Engine</span>
          </h1>
          <p className="text-[14px] text-text-secondary">
            AI-powered content creation workflow
          </p>
        </div>

        <form onSubmit={handleLogin} className="space-y-5">
          <Input
            label="Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            required
          />
          <Input
            label="Password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Your password"
            required
          />
          {error && (
            <p className="text-[13px] text-accent-danger">{error}</p>
          )}
          <Button
            type="submit"
            loading={loading}
            className="w-full"
          >
            Sign In
          </Button>
        </form>
      </div>
    </div>
  );
}
