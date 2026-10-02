import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useEffect } from "react";
import Rules from "./pages/Rules";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Lobby from "./pages/Lobby";
import Arena from "./pages/arena/Arena";
import Questions from "./pages/Questions";
import Complete from "./pages/Complete";
import Leaderboard from "./pages/Leaderboard";
import Admin from "./pages/Admin";
import NotFound from "./pages/NotFound";
import { AuthProvider } from "./context/AuthContext";
import { EventProvider } from "./context/EventContext";
import { MeProvider } from "./context/MeContext";
import { ProtectedRoute } from "./components/ProtectedRoute";

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

export default function App() {
  return (
    <AuthProvider>
      <MeProvider>
      <EventProvider>
      <ScrollToTop />
      <Routes>
        <Route path="/" element={<Navigate to="/login" replace />} />
        <Route path="/rules" element={<Rules />} />
        <Route path="/login" element={<Login />} />
        <Route path="/leaderboard" element={<Leaderboard />} />

        {/* Protected Participant Routes */}
        <Route
          path="/dashboard"
          element={
            <ProtectedRoute>
              <Dashboard />
            </ProtectedRoute>
          }
        />
        <Route
          path="/lobby"
          element={
            <ProtectedRoute>
              <Lobby />
            </ProtectedRoute>
          }
        />
        <Route
          path="/arena"
          element={
            <ProtectedRoute>
              <Arena />
            </ProtectedRoute>
          }
        />
        <Route
          path="/questions"
          element={
            <ProtectedRoute>
              <Questions />
            </ProtectedRoute>
          }
        />
        <Route
          path="/complete"
          element={
            <ProtectedRoute>
              <Complete />
            </ProtectedRoute>
          }
        />

        {/* Protected Admin Routes */}
        <Route
          path="/admin"
          element={
            <ProtectedRoute adminOnly>
              <Admin />
            </ProtectedRoute>
          }
        />

        <Route path="*" element={<NotFound />} />
      </Routes>
      </EventProvider>
      </MeProvider>
    </AuthProvider>
  );
}
