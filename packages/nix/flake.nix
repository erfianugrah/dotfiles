{
  description = "Steam Deck Home Manager Configuration";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    home-manager = {
      url = "github:nix-community/home-manager";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, home-manager, ... }: let
    mkHome = username: home-manager.lib.homeManagerConfiguration {
      pkgs = nixpkgs.legacyPackages.x86_64-linux;
      extraSpecialArgs = { inherit username; };
      modules = [ ./home.nix ];
    };
  in {
    # `home-manager switch --flake .#deck` (Steam Deck)
    homeConfigurations."deck" = mkHome "deck";
    # `home-manager switch --flake .#erfi` (NixOS boxes - e.g. MS-01 eval)
    homeConfigurations."erfi" = mkHome "erfi";
  };
}
