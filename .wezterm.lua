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

-- Switching to relative workspaces
wezterm.on("update-right-status", function(window, pane)
	window:set_right_status(window:active_workspace())
end)

-- Tmux alternative
config.leader = { key = "a", mods = "CTRL", timeout_milliseconds = 2000 }
config.keys = {
	-- Relative Navigation for workspaces
	{ key = "n", mods = "LEADER", action = act.SwitchWorkspaceRelative(1) },
	{ key = "p", mods = "LEADER", action = act.SwitchWorkspaceRelative(-1) },
	-- Show the launcher in fuzzy selection mode and have it list all workspaces
	-- and allow activating one.
	{
		key = "c",
		mods = "LEADER",
		action = act.ShowLauncherArgs({
			flags = "FUZZY|WORKSPACES",
		}),
	},
	-- splitting panes
	{
		mods = "LEADER",
		key = "-",
		action = act.SplitVertical({ domain = "CurrentPaneDomain" }),
	},
	{
		mods = "LEADER",
		key = "=",
		action = act.SplitHorizontal({ domain = "CurrentPaneDomain" }),
	},
	{
		mods = "LEADER",
		key = "m",
		action = act.TogglePaneZoomState,
	},
	-- rotate panes
	{
		mods = "LEADER",
		key = "Space",
		action = act.RotatePanes("Clockwise"),
	},
	-- show the pane selection mode, but have it swap the active and selected panes
	{
		mods = "LEADER",
		key = "0",
		action = wezterm.action.PaneSelect({
			mode = "SwapWithActive",
		}),
	},
	-- Close Current Pane
	{
		key = "w",
		mods = "LEADER",
		action = act.CloseCurrentPane({ confirm = false }),
	},
	-- Pane Navigation
	{
		key = "h",
		mods = "LEADER",
		action = act.ActivatePaneDirection("Left"),
	},
	{
		key = "l",
		mods = "LEADER",
		action = act.ActivatePaneDirection("Right"),
	},
	{
		key = "k",
		mods = "LEADER",
		action = act.ActivatePaneDirection("Up"),
	},
	{
		key = "j",
		mods = "LEADER",
		action = act.ActivatePaneDirection("Down"),
	},
	-- Keybind for launch_menu
	{ mods = "ALT", key = "L", action = wezterm.action.ShowLauncher },
}

-- Windows
if wezterm.target_triple == "x86_64-pc-windows-msvc" then
	-- Paste Action
	-- config.keys = {
	-- 	-- paste from the clipboard
	-- 	{ key = "V", mods = "CTRL", action = act.PasteFrom("Clipboard") },
	-- 	-- paste from the primary selection
	-- 	{ key = "V", mods = "CTRL", action = act.PasteFrom("PrimarySelection") },
	-- }
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

-- Fonts
config.font = wezterm.font({ family = "IosevkaTerm NF", weight = "Regular" })
config.font_size = 11
config.line_height = 1

-- Window Close Prompt
config.window_close_confirmation = "NeverPrompt"

-- and finally, return the configuration to wezterm
return config
