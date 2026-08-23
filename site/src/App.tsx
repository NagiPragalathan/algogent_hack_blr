import { Navigate, Route, Routes } from "react-router-dom";
import { Navbar } from "@/components/navbar";
import { Footer } from "@/components/footer";
import { ScrollManager } from "@/components/scroll-manager";
import { Home } from "@/pages/home";
import { AgentsPage } from "@/pages/agents";

/**
 * The shell: chrome that is on every route, and the routes themselves.
 *
 * The navbar and footer sit outside <Routes> so a route change swaps the page
 * body and nothing else — remounting the bar would replay its entrance
 * animation on every navigation.
 *
 * The catch-all redirects rather than rendering a 404 page: there are two
 * routes, and anything else is a mistyped or stale URL for which the home page
 * is a more useful landing than an apology.
 */
export default function App() {
  return (
    <>
      <ScrollManager />
      <Navbar />
      <main>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/agents" element={<AgentsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      <Footer />
    </>
  );
}
