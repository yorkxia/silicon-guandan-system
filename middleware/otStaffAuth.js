function requireOtStaffAuth(req, res, next) {
  if (req.session && req.session.otStaff) {
    return next();
  }
  req.flash('error', '请先登录 | Please login first');
  res.redirect('/ot-staff/login');
}

module.exports = { requireOtStaffAuth };
