# reproduce_fit.R
#
# Independent cross-check of the browser tool's regression, for the registered
# valuer or analyst. It reads the two files the tool exports from the
# "Valuation roll" tab:
#
#   valuation_roll.csv     one row per property (areas, sample values, char_* columns)
#   valuation_weights.csv  the fitted terms for each model (kind, status, coefficient)
#
# and refits each model with lm(), using offset() for locked weights exactly as
# the tool does. It then prints the tool's coefficient next to R's.
#
# NOTE: this script was written without access to an R installation and has
# not been executed. Run it in Positron / RStudio and report any problem.
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

# Build the design column for one exported term from the roll data
term_column <- function(term, area) {
  kind <- term$Kind
  label <- term$Term
  if (kind == "intercept") return(rep(1, nrow(roll)))
  if (kind == "area") return(if (term$Form == "loglog") log(area) else area)
  if (kind == "category") {
    # label is "Feature name: Category"
    parts <- str_split_fixed(label, ": ", 2)
    col <- paste0("char_", parts[1])
    return(as.integer(roll[[col]] == parts[2]))
  }
  if (kind == "boolean") {
    col <- paste0("char_", label)
    v <- str_to_lower(roll[[col]])
    return(as.integer(v %in% c("yes", "y", "true", "1")))
  }
  if (kind == "numeric") return(num(roll[[paste0("char_", label)]]))
  stop("unknown term kind: ", kind)
}

refit <- function(model_kind) {
  w <- weights %>%
    filter(Model == model_kind, Kind != "", !Status %in% c("base", "excluded", "aliased"))
  if (nrow(w) == 0) {
    cat("\n", model_kind, "model: no fitted terms in the weights file\n")
    return(invisible(NULL))
  }
  form <- w$Form[1]
  area <- if (model_kind == "land") num(roll$LandArea_m2) else num(roll$BuiltArea_m2)
  value <- if (model_kind == "land") num(roll$LandValue_sample) else num(roll$ImprovementValue_sample)
  y <- if (form == "linear") value else log(value)

  X <- map(seq_len(nrow(w)), ~ term_column(w[.x, ], area)) %>% set_names(w$Term)
  X <- as_tibble(X, .name_repair = "minimal")

  keep <- !is.na(y) & complete.cases(X) & (form == "linear" | (!is.na(area) & area > 0))
  y <- y[keep]
  X <- X[keep, , drop = FALSE]

  locked <- w$Status == "locked"
  off <- if (any(locked)) as.matrix(X[, locked, drop = FALSE]) %*% as.numeric(w$Coefficient[locked]) else rep(0, length(y))
  Xfree <- as.matrix(X[, !locked, drop = FALSE])

  fit <- lm(y ~ 0 + Xfree + offset(off))

  tool_coef <- as.numeric(w$Coefficient[!locked])
  comparison <- tibble(
    term = w$Term[!locked],
    tool = tool_coef,
    r = unname(coef(fit)),
    difference = tool - r
  )
  cat("\n==", model_kind, "model (", form, "), n =", length(y), "==\n")
  print(comparison, n = Inf)
  if (any(locked)) {
    cat("Locked terms (offset):", paste(w$Term[locked], "=", w$Coefficient[locked], collapse = "; "), "\n")
  }
  # R-squared computed against the full prediction (including offset), as in the tool
  fitted_full <- as.numeric(Xfree %*% coef(fit)) + as.numeric(off)
  r2 <- 1 - sum((y - fitted_full)^2) / sum((y - mean(y))^2)
  cat("R-squared (fit scale):", round(r2, 4), "\n")
  cat("Max |difference| in coefficients:", signif(max(abs(comparison$difference)), 3), "\n")
  invisible(fit)
}

refit("land")
refit("improvement")
