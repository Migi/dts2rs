#[macro_use]
extern crate stdweb;

extern crate pixi_js;

use pixi_js::prelude::*;
use stdweb::web::*;

fn exampleMain() -> Result<(), &'static str> {
	let pixi = pixi_js::PIXI::__LazyNamespace_PIXI::__init_from_js_value(js!(return PIXI;))?;

	let app = pixi.Application()?.new1(Some(js!(return {
		width: 800,
		height: 600,
		backgroundColor : 0x1099bb
	};)));
	document().body().expect("No body found!").append_child(&app.get_view());

	// create a new Sprite from an image path
	let bunny = pixi.Sprite()?.fromImage("https://pixijs.io/examples/required/assets/basics/bunny.png", None, None);

	// center the sprite's anchor point
	bunny.get_anchor().set(Some(0.5), Some(0.5));

	// move the sprite to the center of the screen
	bunny.set_x(app.get_screen().get_width() / 2.);
	bunny.set_y(app.get_screen().get_height() / 2.);

	app.get_stage().addChild(bunny, stdweb::Undefined);

	// Listen for animate update
	/*app.get_ticker().add(function(delta) {
		// just for fun, let's rotate mr rabbit a little
		// delta is 1 if running at 100% performance
		// creates frame-independent transformation
		bunny.rotation += 0.1 * delta;
	}, None);*/

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