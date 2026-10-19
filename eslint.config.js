import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
	{ ignores: ["node_modules", "dist", ".wrangler"] },
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		rules: {
			"no-console": ["error", { allow: ["log", "error"] }],
		},
	},
);
