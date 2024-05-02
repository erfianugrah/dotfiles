-- Pull in the wezterm API
local wezterm = require("wezterm")

-- This will hold the configuration.
local config = wezterm.config_builder()
local gpus = wezterm.gui.enumerate_gpus()
local act = wezterm.action
-- Theme
config.color_scheme = "lovelace"

-- Window Size
config.initial_rows = 40
config.initial_cols = 160

-- Cursor
config.default_cursor_style = "BlinkingBar"

-- FPS
config.animation_fps = 120

-- GPU Acceleration
config.front_end = "WebGpu"
config.webgpu_preferred_adapter = gpus[1]

--Scrollback
config.scrollback_lines = 5000

-- Windows
if wezterm.target_triple == "x86_64-pc-windows-msvc" then
	-- Paste Action
	config.keys = {
		-- paste from the clipboard
		{ key = "V", mods = "CTRL", action = act.PasteFrom("Clipboard") },
		-- paste from the primary selection
		{ key = "V", mods = "CTRL", action = act.PasteFrom("PrimarySelection") },
	}
	-- GPU
	config.front_end = "WebGpu"
	config.webgpu_preferred_adapter = gpus[1]

	-- WSL
	config.default_domain = "WSL:Ubuntu"
	config.default_cwd = "/home/erfi"
	config.launch_menu = {
		{
			label = "PowerShell",
			domain = { DomainName = "local" },
			args = { "powershell.exe", "-NoLogo" },
		},
	}
end

-- Keybind for launch_menu
config.keys = {
	{ key = "l", mods = "ALT", action = wezterm.action.ShowLauncher },
}
-- Fonts
config.font = wezterm.font({ family = "IosevkaTerm NF", weight = "Regular" })
config.font_size = 12
config.line_height = 1

-- Window Close Prompt
config.window_close_confirmation = "NeverPrompt"

-- and finally, return the configuration to wezterm
return config
