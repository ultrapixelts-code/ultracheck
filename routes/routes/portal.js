import express from "express";

const router = express.Router();

// Dashboard portal
router.get("/", (req, res) => {
  res.render("portal/dashboard", {
    user: { email: "demo@ultrapixel.it" }
  });
});

// Login portal (per ora finto)
router.get("/login", (req, res) => {
  res.render("portal/login", { error: null });
});

export default router;
