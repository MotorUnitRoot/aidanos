// One mask for relay logs and git errors. ghp_, gho_, ghs_, ghu_, and ghr_
// take a body of 36 to 251 characters. A fine-grained github_pat_ keeps the
// classic floor of 22 characters and has no upper bound, so a token longer
// than ghp_ or the classic 93-character PAT is still masked. Neither
// pattern requires a word boundary, so a token glued to
// the surrounding text is still masked. The regexes are built per call so
// a shared lastIndex cannot skip a later match.

export const GH_APP_TOKEN_SOURCE = "gh[pousr]_[A-Za-z0-9]{36,251}";
export const GH_PAT_TOKEN_SOURCE = "github_pat_[A-Za-z0-9_]{22,}";
// Longest ghp_/gho_/ghs_/ghu_/ghr_ match, in bytes. The body is ASCII.
export const GH_APP_TOKEN_BYTES = 4 + 251;

export function maskGitHubTokens(text) {
  return String(text)
    .replace(new RegExp(GH_APP_TOKEN_SOURCE, "g"), "***")
    .replace(new RegExp(GH_PAT_TOKEN_SOURCE, "g"), "***");
}
