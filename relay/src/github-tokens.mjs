// One mask for relay logs and git errors. ghp_, gho_, ghs_, ghu_, and ghr_
// need a body of at least 36 characters. The mask consumes the whole run
// of token characters, so a body longer than 251 leaves no tail. A
// fine-grained github_pat_ keeps the classic floor of 22 characters and
// also has no upper bound. Neither pattern requires a word boundary, so
// a token glued to the surrounding text is still masked. The regexes are
// built per call so a shared lastIndex cannot skip a later match.

export const GH_APP_TOKEN_SOURCE = "gh[pousr]_[A-Za-z0-9]{36,}";
export const GH_PAT_TOKEN_SOURCE = "github_pat_[A-Za-z0-9_]{22,}";
// Margin floor for the mask window, in bytes. The match itself has no
// upper bound. The body is ASCII.
export const GH_APP_TOKEN_BYTES = 4 + 251;

export function maskGitHubTokens(text) {
  return String(text)
    .replace(new RegExp(GH_APP_TOKEN_SOURCE, "g"), "***")
    .replace(new RegExp(GH_PAT_TOKEN_SOURCE, "g"), "***");
}
