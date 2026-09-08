# Executes lane selection with all external effects replaced by recording stubs.
require "json"
module UI
  def self.message(*) ; end
  def self.success(*) ; end
  def self.user_error!(message) ; raise message ; end
end
$lanes = {}
$calls = []
def default_platform(*) ; end
def before_all(&block) ; $guard = block ; end
def platform(name, &block) ; $platform = name ; block.call ; end
def desc(*) ; end
def lane(name, &block) ; $lanes[[$platform.to_s, name.to_s]] = block ; end
def sh(*args) ; $calls << {action: "sync", args: args, target: ENV["CAPACITOR_TARGET"]} ; end
def gradle(options) ; $calls << {action: "gradle", options: options, target: ENV["CAPACITOR_TARGET"]} ; end
def build_app(options) ; $calls << {action: "build", options: options, target: ENV["CAPACITOR_TARGET"]} ; end
def app_store_connect_api_key(options)
  raise "Expected key content" unless options[:key_content] == "fixture-only-not-a-key"
  {key_id: options[:key_id], issuer_id: options[:issuer_id]}
end
def upload_to_testflight(options) ; $calls << {action: "testflight", options: options} ; end
def upload_to_play_store(options) ; $calls << {action: "play", options: options} ; end
load File.expand_path("../../fastlane/Fastfile", __dir__)
$guard.call
$lanes.fetch([ARGV[0], ARGV[1]]).call
puts JSON.generate($calls)
