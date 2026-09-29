import { motion, AnimatePresence } from "framer-motion";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { useState } from "react";
import { browserLocalPersistence, browserSessionPersistence, createUserWithEmailAndPassword, GoogleAuthProvider, setPersistence, signInWithEmailAndPassword, signInWithPopup, updateProfile } from "firebase/auth";
import { auth, firebaseConfigured } from "@/lib/firebase";

const GoogleIcon = () => (
  <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none">
    <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
    <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
    <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
    <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
  </svg>
);

export default function Login() {
  const [tab, setTab] = useState<"signin" | "signup">("signup");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [company, setCompany] = useState("");
  const [rememberMe, setRememberMe] = useState(false);
  const [signupEmailFocused, setSignupEmailFocused] = useState(false);
  const [signupPasswordFocused, setSignupPasswordFocused] = useState(false);
  const [error, setError] = useState("");
  const [, navigate] = useLocation();

  const changeTab = (nextTab: "signin" | "signup") => {
    if (nextTab === "signup") {
      setSignupEmailFocused(false);
      setSignupPasswordFocused(false);
    }
    setTab(nextTab);
  };

  const persistOwnerName = (value: string) => {
    const trimmed = value.trim();
    if (trimmed) localStorage.setItem("relay_owner_name", trimmed);
  };

  const handleGoogle = async () => {
    setError("");
    if (tab === "signup" && !name.trim()) { setError("Full name is required to create your Relay account."); return; }
    if (!firebaseConfigured || !auth) { setError("Firebase authentication is not configured yet."); return; }
    try { if (tab === "signin") await setPersistence(auth, rememberMe ? browserLocalPersistence : browserSessionPersistence); const credential = await signInWithPopup(auth, new GoogleAuthProvider()); const ownerName = name.trim() || credential.user.displayName || ""; if (tab === "signup") await updateProfile(credential.user, { displayName: ownerName }); persistOwnerName(ownerName); navigate(tab === "signup" ? "/onboarding" : "/dashboard"); }
    catch (err) { setError(err instanceof Error ? err.message : "Unable to continue with Google."); }
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault(); setError("");
    if (tab === "signup" && !name.trim()) { setError("Full name is required to create your Relay account."); return; }
    if (!firebaseConfigured || !auth) { setError("Firebase authentication is not configured yet."); return; }
    try {
      if (tab === "signup") {
        const credential = await createUserWithEmailAndPassword(auth, email, password);
        await updateProfile(credential.user, { displayName: name.trim() });
        persistOwnerName(name);
      } else { await setPersistence(auth, rememberMe ? browserLocalPersistence : browserSessionPersistence); const credential = await signInWithEmailAndPassword(auth, email, password); persistOwnerName(credential.user.displayName || ""); }
      navigate(tab === "signup" ? "/onboarding" : "/dashboard");
    } catch (err) { setError(err instanceof Error ? err.message : "Unable to authenticate."); }
  };

  return (
    <div className="min-h-screen bg-background flex flex-col font-sans">
      {/* Blob backgrounds */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden -z-10">
        <svg className="absolute right-[-5%] top-[-10%] w-[500px] h-[500px] opacity-10 text-primary" viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
          <path fill="currentColor" d="M44.7,-76.4C58.8,-69.2,71.8,-59.1,81.1,-46.1C90.4,-33.1,96,-16.6,95.5,-0.3C95,16,88.4,32.1,78.5,45.4C68.6,58.7,55.3,69.2,40.7,75.4C26.1,81.6,10.2,83.5,-4.8,81.3C-19.8,79,-33.9,72.6,-46.3,63.9C-58.7,55.2,-69.3,44.2,-76.7,31.2C-84.1,18.2,-88.3,3.1,-87.3,-11.6C-86.3,-26.3,-80.1,-40.6,-70.7,-51.7C-61.3,-62.8,-48.7,-70.7,-35.3,-76.1C-21.9,-81.5,-7.7,-84.4,6.7,-83.4C21.1,-82.4,30.6,-83.6,44.7,-76.4Z" transform="translate(100 100)" />
        </svg>
        <svg className="absolute left-[-5%] bottom-[10%] w-[400px] h-[400px] opacity-10 text-primary" viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
          <path fill="currentColor" d="M51.5,-67.2C65.5,-59.1,74.8,-43.3,81.4,-26.5C88,-9.7,91.9,8,86.6,23.1C81.3,38.2,66.8,50.7,51.2,60.8C35.6,70.9,18.9,78.6,1.4,76.8C-16.1,75,-32.2,63.7,-46.8,51.8C-61.4,39.9,-74.5,27.4,-80.2,11.5C-85.9,-4.4,-84.2,-23.7,-74.6,-38.7C-65,-53.7,-47.4,-64.4,-31.2,-71.4C-15,-78.4,3.7,-81.7,20.8,-77.9C37.9,-74.1,37.5,-75.3,51.5,-67.2Z" transform="translate(100 100)" />
        </svg>
      </div>

      {/* Header */}
      <header className="px-6 py-5 flex items-center justify-between">
        <Link href="/" className="hidden items-center gap-2 sm:flex">
          <img src="/logo.png" alt="Relay" className="h-7 w-auto" />
        </Link>
        <p className="text-sm text-muted-foreground">
          {tab === "signin" ? (
            <>
              New to Relay?{" "}
              <button onClick={() => changeTab("signup")} className="text-primary font-medium hover:underline">
                Create account
              </button>
            </>
          ) : (
            <>
              Already have an account?{" "}
              <button onClick={() => changeTab("signin")} className="text-primary font-medium hover:underline">
                Sign in
              </button>
            </>
          )}
        </p>
      </header>

      <main className="flex-1 flex items-center justify-center px-4 py-12">
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="w-full max-w-sm"
        >
          {/* Tab switcher */}
          <div className="flex rounded-xl border border-border bg-muted/40 p-1 mb-8">
            {(["signup", "signin"] as const).map((t) => (
              <button
                key={t}
                onClick={() => changeTab(t)}
                className={`flex-1 py-2 text-sm font-semibold rounded-lg transition-all duration-200 ${
                  tab === t
                    ? "bg-card shadow-sm text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
                data-testid={`tab-${t}`}
              >
                {t === "signup" ? "Get Started Free" : "Sign In"}
              </button>
            ))}
          </div>

          <AnimatePresence mode="wait">
            <motion.div
              key={tab}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2 }}
            >
              <div className="text-center mb-6">
                <h1 className="text-2xl font-bold text-foreground mb-1">
                  {tab === "signup" ? "Create your account" : "Welcome back"}
                </h1>
                <p className="text-muted-foreground text-sm">
                  {tab === "signup"
                    ? "Start your first month free. No credit card required."
                    : "Sign in to your Relay dashboard"}
                </p>
              </div>

              <Card className="p-7 border border-border bg-card rounded-2xl shadow-sm">
                {/* Google SSO — always first */}
                <Button
                  type="button"
                  variant="outline"
                  className="w-full h-11 rounded-xl border-border hover:bg-muted/60 font-medium flex items-center gap-2.5 mb-5"
                  onClick={handleGoogle}
                  data-testid="button-login-google"
                >
                  <GoogleIcon />
                  {tab === "signup" ? "Sign up with Google" : "Continue with Google"}
                </Button>

                <div className="relative mb-5">
                  <div className="absolute inset-0 flex items-center">
                    <div className="w-full border-t border-border" />
                  </div>
                  <div className="relative flex justify-center text-xs uppercase">
                    <span className="bg-card px-3 text-muted-foreground font-medium tracking-wider">
                      or with email
                    </span>
                  </div>
                </div>

                <form onSubmit={handleSubmit} autoComplete={tab === "signin" ? "on" : "off"} className="space-y-4">
                  {tab === "signup" && (
                    <>
                      <div className="space-y-1.5">
                        <Label htmlFor="full-name" className="text-sm font-medium text-foreground">
                          Full name
                        </Label>
                        <Input
                          id="full-name"
                          type="text"
                          autoComplete="off"
                          placeholder="James Okafor"
                          value={name}
                          onChange={(e) => setName(e.target.value)}
                          className="h-11 rounded-xl border-border bg-background"
                          data-testid="input-name"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="company" className="text-sm font-medium text-foreground">
                          Organisation
                        </Label>
                        <Input
                          id="company"
                          type="text"
                          autoComplete="off"
                          placeholder="City National Bank"
                          value={company}
                          onChange={(e) => setCompany(e.target.value)}
                          className="h-11 rounded-xl border-border bg-background"
                          data-testid="input-company"
                        />
                      </div>
                    </>
                  )}

                  <div className="space-y-1.5">
                    <Label htmlFor="email" className="text-sm font-medium text-foreground">
                      Email
                    </Label>
                    <Input
                      id="email"
                      type="email"
                      autoComplete={tab === "signin" ? "username" : "off"}
                      name={tab === "signin" ? "username" : "signup-email"}
                      readOnly={tab === "signup" && !signupEmailFocused}
                      onFocus={() => { if (tab === "signup") setSignupEmailFocused(true); }}
                      placeholder="you@organisation.com"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="h-11 rounded-xl border-border bg-background"
                      data-testid="input-email"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="password" className="text-sm font-medium text-foreground">
                        Password
                      </Label>
                      {tab === "signin" && (
                        <Link href="#" className="text-xs text-primary hover:underline font-medium">
                          Forgot password?
                        </Link>
                      )}
                    </div>
                    <Input
                      id="password"
                      type="password"
                      autoComplete={tab === "signin" ? "current-password" : "off"}
                      name={tab === "signin" ? "password" : "signup-password"}
                      readOnly={tab === "signup" && !signupPasswordFocused}
                      onFocus={() => { if (tab === "signup") setSignupPasswordFocused(true); }}
                      placeholder="••••••••"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="h-11 rounded-xl border-border bg-background"
                      data-testid="input-password"
                    />
                  </div>

                  {tab === "signin" && (
                    <label className="flex items-center gap-2 text-sm text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={rememberMe}
                        onChange={(event) => setRememberMe(event.target.checked)}
                        className="h-4 w-4 rounded border-border accent-primary"
                      />
                      Remember me
                    </label>
                  )}

                  <Button
                    type="submit"
                    className="w-full h-11 rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 font-semibold mt-1"
                    data-testid="button-login-submit"
                  >
                    {tab === "signup" ? "Create account" : "Sign in"}
                  </Button>
                  {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
                </form>
              </Card>

              <p className="text-center text-xs text-muted-foreground mt-5">
                By continuing you agree to our{" "}
                <Link href="/terms" className="text-primary hover:underline">
                  Terms
                </Link>{" "}
                and{" "}
                <Link href="/privacy" className="text-primary hover:underline">
                  Privacy Policy
                </Link>
                .
              </p>
            </motion.div>
          </AnimatePresence>
        </motion.div>
      </main>
    </div>
  );
}
