function requireAuth(req, res, next) {
  if (req.session && req.session.user) {
    return next();
  }
  req.flash('error', '请先登录 | Please login first');
  res.redirect('/admin/login');
}

function requireSuperAdmin(req, res, next) {
  if (req.session && req.session.user && req.session.user.is_super_admin) {
    return next();
  }
  req.flash('error', '权限不足，需要超级管理员权限 | Super admin required');
  res.redirect('/admin/dashboard');
}

module.exports = { requireAuth, requireSuperAdmin };
