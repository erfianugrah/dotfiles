-- Pull in the wezterm API
local wezterm = require("wezterm")
local mux = wezterm.mux
-- This will hold the configuration.
local config = wezterm.config_builder()
-- local gpus = wezterm.gui.enumerate_gpus()
local act = wezterm.action
-- Theme
config.color_scheme = "lovelace"

-- Window Size
config.initial_rows = 40
config.initial_cols = 160

-- Cursor
-- config.default_cursor_style = "BlinkingBar"

-- FPS
config.animation_fps = 120

-- GPU Acceleration
-- config.front_end = "WebGpu"
-- config.webgpu_preferred_adapter = gpus[1]

--Scrollback
config.scrollback_lines = 10000
act.SendKey({
	key = "RightArrow",
	mods = "CTRL",
})

act.SendKey({
	key = "LeftArrow",
	mods = "CTRL",
})

-- Switching to relative workspaces
wezterm.on("update-right-status", function(window, pane)
	window:set_right_status(window:active_workspace())
end)

-- Tmux alternative
config.leader = { key = "A", mods = "CTRL" }
config.keys = {
	-- Jump words
	{
		key = "LeftArrow",
		mods = "CTRL",
		action = act.SendKey({
			key = "b",
			mods = "ALT",
		}),
	},
	{
		key = "RightArrow",
		mods = "CTRL",
		action = act.SendKey({
			key = "f",
			mods = "ALT",
		}),
	},
	-- Delete by word
	{
		key = "Backspace",
		mods = "CTRL",
		action = act.SendKey({
			key = "w",
			mods = "CTRL",
		}),
	},
	-- Relative Navigation for workspaces
	{ key = "n", mods = "LEADER", action = act.SwitchWorkspaceRelative(1) },
	{ key = "p", mods = "LEADER", action = act.SwitchWorkspaceRelative(-1) },
	-- Show the launcher in fuzzy selection mode and have it list all workspaces
	-- and allow activating one.
	{
		key = "s",
		mods = "LEADER",
		action = act.ShowLauncherArgs({
			flags = "FUZZY|WORKSPACES",
		}),
	},
	{
		key = "c",
		mods = "LEADER",
		action = act.PromptInputLine({
			description = wezterm.format({
				{ Attribute = { Intensity = "Bold" } },
				{ Foreground = { AnsiColor = "Fuchsia" } },
				{ Text = "Enter name for new workspace" },
			}),
			action = wezterm.action_callback(function(window, pane, line)
				-- line will be `nil` if they hit escape without entering anything
				-- An empty string if they just hit enter
				-- Or the actual line of text they wrote
				if line then
					window:perform_action(
						act.SwitchToWorkspace({
							name = line,
						}),
						pane
					)
				end
			end),
		}),
	},
	-- {
	-- 	key = "r",
	-- 	mods = "LEADER",
	-- 	action = mux.rename_workspace(mux.get_active_workspace()),
	-- },
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
		action = act.PaneSelect({
			mode = "SwapWithActive",
		}),
	},
	-- Open new tab in current domain
	{
		key = "t",
		mods = "LEADER",
		action = act.SpawnTab("CurrentPaneDomain"),
	},
	-- Close Current Pane
	{
		key = "w",
		mods = "LEADER",
		action = act.CloseCurrentPane({ confirm = false }),
	},
	-- Close Current Tab
	{
		key = "x",
		mods = "LEADER",
		action = act.CloseCurrentTab({ confirm = true }),
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
	{ mods = "ALT", key = "l", action = wezterm.action.ShowLauncher },
}
for i = 1, 8 do
	table.insert(config.keys, {
		key = tostring(i),
		mods = "LEADER",
		action = act.ActivateTab(i - 1),
	})
end
-- Windows
if wezterm.target_triple == "x86_64-pc-windows-msvc" then
	-- Paste Action
	table.insert(config.keys, { key = "v", mods = "CTRL", action = wezterm.action.Nop })
	table.insert(config.keys, { key = "V", mods = "CTRL", action = act.PasteFrom("Clipboard") })
	-- config.keys = {
	-- 	{ key = "v", mods = "CTRL", action = wezterm.action.Nop },
	-- 	-- -- paste from the clipboard
	-- 	-- { key = "V", mods = "CTRL", action = act.PasteFrom("Clipboard") },
	-- 	-- -- paste from the primary selection
	-- 	-- { key = "V", mods = "CTRL", action = act.PasteFrom("PrimarySelection") },
	-- }
	-- GPU
	-- config.front_end = "WebGpu"
	-- config.webgpu_preferred_adapter = gpus[1]

	-- WSL
	config.default_domain = "WSL:Ubuntu"
	config.default_cwd = "/home/erfi"
	config.launch_menu = {
		{
			label = "PowerShell",
			domain = { DomainName = "local" },
			args = { "powershell.exe", "-NoLogo" },
		},
		{
			label = "Command Prompt",
			domain = { DomainName = "local" },
			args = { "cmd.exe" },
		},
		{
			label = "WSL2",
			domain = { DomainName = "local" },
			args = { "wsl.exe" },
		},
	}
end

-- Fonts
config.font = wezterm.font({ family = "IosevkaTerm NF", weight = "Regular" })
config.font_size = 12
config.line_height = 1

-- Window Close Prompt
config.window_close_confirmation = "NeverPrompt"

-- and finally, return the configuration to wezterm
return config
