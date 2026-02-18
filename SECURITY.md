# Security Policy

## Supported Versions

We release patches for security vulnerabilities. Currently supported versions:

| Version | Supported          |
| ------- | ------------------ |
| latest  | :white_check_mark: |
| < latest | :x:                |

## Reporting a Vulnerability

If you discover a security vulnerability in Grook, please report it responsibly.

**DO NOT** open a public GitHub issue for security vulnerabilities.

### How to Report

1. **Contact the maintainers directly**:
   - Gabe Schrock (GitHub: @2wiceUponATime, Slack: @gabeschrock)
   - Sami (GitHub: @sami9889, Slack: @samisingh988)

2. **Include in your report**:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Any suggested fixes (optional)

3. **Response timeline**:
   - Initial response: within 48 hours
   - Status update: within 7 days
   - Fix timeline: depends on severity

### What to Expect

- We will acknowledge receipt of your report
- We will investigate and keep you updated on progress
- We will credit you in the fix (unless you prefer to remain anonymous)
- We will not take legal action against researchers who follow responsible disclosure

## Security Best Practices for Deployment

When deploying Grook:

1. **API Tokens**: Store Slack and Anthropic API tokens in environment variables, never commit them to the repository
2. **Permissions**: Grant Grook only the minimum Slack permissions it needs to function
3. **Rate Limiting**: Implement rate limiting to prevent abuse
4. **Input Validation**: Validate all user inputs before processing
5. **Monitoring**: Monitor for unusual activity or abuse patterns
6. **Updates**: Keep dependencies up to date
7. **Branch Protection**: Maintain branch protection on main (like Gabe did)

## Scope

This security policy covers:
- The Grook bot codebase
- Slack integration vulnerabilities
- API key handling
- User data handling and privacy
- Tool function security

Out of scope:
- Third-party services (Slack, Anthropic API) - report those to the respective vendors
- Social engineering attacks against users
- Issues in dependencies (report to the dependency maintainers)

## Disclosure Policy

- We follow responsible disclosure practices
- Security issues will be disclosed publicly after a fix is available
- Critical vulnerabilities may be disclosed with a coordinated timeline

## Known Security Considerations

- **Tool breakage**: If tools fail, Grook has fallback behavior to prevent crashes
- **User mentions**: Grook only pings users when necessary to avoid spam
- **Content filtering**: Grook maintains SFW/PG-13 content limits
- **DM security**: DMs always include attribution of who requested them
