/**
 * Mock Auth Module for Testing
 */
function login(user, pass) {
  console.log("Logging in:", user);
  return true;
}

function logout() {
  console.log("Logging out");
}

module.exports = { login, logout };
