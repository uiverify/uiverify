import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Brand } from "@/components/Header";
import { Icon } from "@/components/Icon";
import { ProductArt } from "@/components/ProductArt";

/** Google's multicolor "G" mark. */
function GoogleMark() {
  return (
    <svg className="gicon" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path
        fill="#FFC107"
        d="M43.6 20.5H42V20H24v8h11.3C33.7 32.4 29.3 35 24 35c-6.1 0-11-4.9-11-11s4.9-11 11-11c2.8 0 5.4 1.1 7.3 2.9l5.7-5.7C33.5 6.1 29 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.3-.4-3.5z"
      />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 16 19 13 24 13c2.8 0 5.4 1.1 7.3 2.9l5.7-5.7C33.5 6.1 29 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 34.9 26.7 36 24 36c-5.3 0-9.7-3.6-11.3-8.5l-6.5 5C9.6 39.6 16.2 44 24 44z" />
      <path
        fill="#1976D2"
        d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.1-4.1 5.6l6.2 5.2C41.2 36.3 44 30.7 44 24c0-1.3-.1-2.3-.4-3.5z"
      />
    </svg>
  );
}

export function Login() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("maya@example.com");
  const [password, setPassword] = useState("shoppy-demo");

  const signIn = (e: FormEvent) => {
    e.preventDefault();
    navigate("/");
  };

  return (
    <div className="auth">
      <aside className="panel">
        <Brand />
        <ProductArt glyph="plant" gradient="g-plant" className="float-p" />
        <div className="pcopy">
          <span className="tag" style={{ background: "rgba(255,255,255,.2)", color: "#fff" }}>
            <Icon name="i-sparkle" size={13} /> Members save more
          </span>
          <h2>
            Good things,
            <br />
            <em>delivered</em> to your door.
          </h2>
          <p>Sign in to track orders, save your favorites, and get early access to every drop.</p>
          <div className="quote">
            <p>"Shoppy is the only shop where I've bought the same mug three times as gifts. Everything just feels good."</p>
            <div className="by">
              <span className="a">M</span> Maya R. · verified buyer
            </div>
          </div>
        </div>
      </aside>

      <main className="form-side">
        <form className="form-box" onSubmit={signIn}>
          <h1>Welcome back</h1>
          <p className="lead">Sign in to your Shoppy account to continue.</p>

          <button type="button" className="google" onClick={() => navigate("/")}>
            <GoogleMark /> Continue with Google
          </button>

          <div className="divider">or sign in with email</div>

          <div className="field">
            <label htmlFor="email">Email address</label>
            <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="password">
              Password{" "}
              <Link className="forgot" to="/login">
                Forgot?
              </Link>
            </label>
            <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>

          <button type="submit" className="btn btn-primary btn-block btn-lg" style={{ marginTop: 22 }}>
            Sign in
          </button>

          <p className="terms">
            By continuing you agree to Shoppy's{" "}
            <Link to="/login">Terms</Link> and <Link to="/login">Privacy Policy</Link>.
          </p>
          <p className="switch">
            New to Shoppy? <Link to="/login">Create an account</Link>
          </p>
        </form>
      </main>
    </div>
  );
}
