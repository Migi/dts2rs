#[macro_use]
extern crate stdweb;

extern crate pixi_js;

use pixi_js::prelude::*;

fn exampleMain() -> Result<(), &'static str> {
	let pixi = pixi_js::PIXI::__LazyNamespace_PIXI::__init_from_js_value(js!(return PIXI;))?;

	let app = pixi.Application()?.new1(js!(return {
		width: 800,
		height: 600,
		backgroundColor : 0x1099bb
	};));
	stdweb::web::document().body().append_child(app.get_view());

	// create a new Sprite from an image path
	let bunny = pixi.Sprite()?.fromImage("https://pixijs.io/examples/required/assets/basics/bunny.png");

	// center the sprite's anchor point
	bunny.anchor.set(0.5);

	// move the sprite to the center of the screen
	bunny.x = app.screen.width / 2;
	bunny.y = app.screen.height / 2;

	app.stage.addChild(bunny);

	// Listen for animate update
	app.ticker.add(function(delta) {
		// just for fun, let's rotate mr rabbit a little
		// delta is 1 if running at 100% performance
		// creates frame-independent transformation
		bunny.rotation += 0.1 * delta;
	});

	Ok(())
}

fn main() {
	let promise = pixi_js::__requireFromUrl__pixi_js("https://cdnjs.cloudflare.com/ajax/libs/pixi.js/4.8.1/pixi.min.js");

	let _done_handle = promise.done(|res: Result<stdweb::Value, stdweb::Value>| {
		if res.is_err() {
			console!(error, "Failed to load script");
			return;
		}

		
	});

	_done_handle.leak();
}