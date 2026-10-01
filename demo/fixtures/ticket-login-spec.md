# DEMO-101 Draft login regression spec

## Requirement
When a user submits the login form with valid credentials, the dashboard screen appears within 3 seconds.

## Context
The login submit button (id: login_submit) navigates to dashboard (id: dash_root).
A known pitfall: the form needs a settle-wait before the submit tap on slow networks.

## Acceptance
- Given the login form, when credentials are valid, then dashboard shows
