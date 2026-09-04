# reproduce_fit.R
#
# Independent cross-check of the browser tool's building-value regression,
# for the registered valuer or analyst. It reads the two files the tool
# exports from the Results tab:
#
#   valuation_roll.csv     one row per property (areas, land value, valuer total, char_* columns)
#   valuation_weights.csv  the fitted terms (kind, status, coefficient)
#
# and refits the model with lm(), using offset() for locked weights exactly
# as the tool does. The dependent variable is the residual building value:
# the valuer's total minus the land value the tool computed from the rate
# schedule (column LandValue in the roll export).
#
# NOTE: written without access to an R installation and not executed.
# Run it in Positron / RStudio and report any problem.
#
# Usage:
#   Rscript r/reproduce_fit.R path/to/valuation_roll.csv path/to/valuation_weights.csv

suppressPackageStartupMessages({
  library(readr)
  library(dplyr)
  library(stringr)
  library(purrr)
  library(tibble)
})

args <- commandArgs(trailingOnly = TRUE)
roll_path <- if (length(args) >= 1) args[1] else "valuation_roll.csv"
weights_path <- if (length(args) >= 2) args[2] else "valuation_weights.csv"

roll <- read_csv(roll_path, show_col_types = FALSE, col_types = cols(.default = col_character()))
weights <- read_csv(weights_path, show_col_types = FALSE, col_types = cols(.default = col_character()))

num <- function(x) parse_number(x)

term_column <- function(term, area) {
  kind <- term$Kind
  label <- term$Term
  if (kind == "intercept") return(rep(1, nrow(roll)))
  if (kind == "area") return(if (term$Form == "loglog") log(area) else area)
  if (kind == "category") {
    parts <- str_split_fixed(label, ": ", 2)
    return(as.integer(roll[[paste0("char_", parts[1])]] == parts[2]))
  }
  if (kind == "boolean") {
    v <- str_to_lower(roll[[paste0("char_", label)]])
    return(as.integer(v %in% c("yes", "y", "true", "1")))
  }
  if (kind == "numeric") return(num(roll[[paste0("char_", label)]]))
  stop("unknown term kind: ", kind)
}

w <- weights %>% filter(Kind != "", !Status %in% c("base", "excluded", "aliased"))
stopifnot(nrow(w) > 0)
form <- w$Form[1]

area <- num(roll$BuiltArea_m2)
residual <- num(roll$ValuerTotal_sample) - num(roll$LandValue)
y <- if (form == "linear") residual else log(residual)

X <- map(seq_len(nrow(w)), ~ term_column(w[.x, ], area)) %>% set_names(w$Term)
X <- as_tibble(X, .name_repair = "minimal")

keep <- !is.na(y) & is.finite(y) & complete.cases(X) & (form == "linear" | (!is.na(area) & area > 0))
y <- y[keep]
X <- X[keep, , drop = FALSE]

locked <- w$Status == "locked"
off <- if (any(locked)) as.matrix(X[, locked, drop = FALSE]) %*% as.numeric(w$Coefficient[locked]) else rep(0, length(y))
Xfree <- as.matrix(X[, !locked, drop = FALSE])

fit <- lm(y ~ 0 + Xfree + offset(off))

comparison <- tibble(
  term = w$Term[!locked],
  tool = as.numeric(w$Coefficient[!locked]),
  r = unname(coef(fit)),
  difference = tool - r
)
cat("\n== building value model (", form, "), n =", length(y), "==\n")
print(comparison, n = Inf)
if (any(locked)) cat("Locked terms (offset):", paste(w$Term[locked], "=", w$Coefficient[locked], collapse = "; "), "\n")
fitted_full <- as.numeric(Xfree %*% coef(fit)) + as.numeric(off)
r2 <- 1 - sum((y - fitted_full)^2) / sum((y - mean(y))^2)
cat("R-squared (fit scale):", round(r2, 4), "\n")
cat("Max |difference| in coefficients:", signif(max(abs(comparison$difference)), 3), "\n")
